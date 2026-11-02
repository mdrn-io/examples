// Invitations: an owner or admin (or any member, when the team allows it) invites someone by
// email, MDRN Mail sends them a link, and they accept it signed in with that same address.
//
// The link carries a one-time secret; only its hash is stored. It is in the URL's #fragment, which
// browsers never send to a server, so it stays out of request logs. Accepting checks that the
// signed-in user's email (read from MDRN, never from the client) is the invited one.
//
// The app mails addresses a user names, so it caps what one team can send per day, counted in the
// database so the cap holds across every Worker instance. The mail's text is fixed: the inviter
// chooses only the address, the role and, through the team's name, one short line.
import { Hono } from 'hono';
import { z } from 'zod';
import { randomToken, safeEqual, sha256 } from '../crypto.ts';
import type { AppEnv, Env } from '../env.ts';
import { fail } from '../errors.ts';
import { identityEmail, mail, ProductError, ProductUnavailable, type StoredRecord } from '../mdrn.ts';
import { store, type Store } from '../store.ts';
import { addMember, all, can, ignoreGone, indexOf, invitesOf, membersOf, membership, type Member, type TeamIndex } from '../teams.ts';
import { body, params, recordId } from '../validate.ts';

const DEFAULT_DAILY_LIMIT = 20;
const MAX_PENDING = 50;
const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;

interface Invite {
  email: string;
  role: 'admin' | 'member';
  tokenHash: string;
  invitedBy: string;
  expiresAt: string;
}

interface Quota {
  day: string;
  count: number;
}

const inviteView = (invite: StoredRecord<Invite>) => ({ id: invite.id, email: invite.data.email, role: invite.data.role, expiresAt: invite.data.expiresAt });
const expired = (invite: StoredRecord<Invite>) => Date.parse(invite.data.expiresAt) <= Date.now();

/** Counts one invitation against the team's daily cap; false when the cap is reached. */
async function takeQuota(db: Store, teamId: string, limit: number): Promise<boolean> {
  const collection = `invite_quota_${teamId}`;
  const today = new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [current] = (await db.list<Quota>(collection, { limit: 1 })).items;
    if (!current) {
      await db.create<Quota>(collection, { day: today, count: 1 });
      return true;
    }
    const used = current.data.day === today ? current.data.count : 0;
    if (used >= limit) return false;
    try {
      await db.update<Quota>(collection, current.id, { day: today, count: used + 1 }, current.version);
      return true;
    } catch (error) {
      // Another invitation counted at the same moment: read the count again.
      if (!(error instanceof ProductError && error.status === 409)) throw error;
    }
  }
  return false;
}

/** Sends the invitation. Answers why it could not, in this app's words, or null when it went. */
async function sendInvite(env: Env, recipient: string, teamName: string, inviter: string | null, link: string): Promise<string | null> {
  try {
    await mail.send(env, {
      recipient,
      subject: `You're invited to join ${teamName}`,
      text: `${inviter ?? 'A teammate'} invited you to join ${teamName}.\n\nOpen this link and sign in with ${recipient} to accept:\n${link}\n\nThe link works for 7 days. If you did not expect this, ignore this email.`,
    });
    return null;
  } catch (error) {
    if (error instanceof ProductUnavailable) return 'Mail is off for this project, so no email was sent.';
    if (!(error instanceof ProductError)) throw error;
    console.error(JSON.stringify({ event: 'invite_mail_failed', status: error.status, code: error.code, message: error.message }));
    if (error.code === 'BUILD_MAIL_RECIPIENT') return 'In build mode, email goes only to members of your workspace, so none was sent to this address.';
    if (error.code === 'SENDER_REQUIRED') return 'Email to this address needs a verified sender domain, so none was sent.';
    return 'The email could not be sent right now.';
  }
}

export const invites = new Hono<AppEnv>();

const teamParam = z.object({ teamId: recordId });

invites.get('/teams/:teamId/invites', params(teamParam), async c => {
  const db = await store(c.env);
  const { teamId } = c.req.valid('param');
  const found = await membership(db, c.get('user').id, teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  if (!can.manageInvites(found.member.data.role)) return fail(c, 403, 'forbidden', 'Only the owner and admins can see invitations.');
  const pending = (await all<Invite>(db, invitesOf(teamId))).filter(invite => !expired(invite));
  return c.json({ items: pending.map(inviteView) });
});

invites.post(
  '/teams/:teamId/invites',
  params(teamParam),
  body(z.strictObject({ email: z.email().max(254).transform(email => email.toLowerCase()), role: z.enum(['admin', 'member']).default('member') })),
  async c => {
    const user = c.get('user');
    const db = await store(c.env);
    const { teamId } = c.req.valid('param');
    const { email, role } = c.req.valid('json');
    const found = await membership(db, user.id, teamId);
    if (!found) return fail(c, 404, 'not_found', 'Team not found.');
    const mine = found.member.data.role;
    if (!can.invite(mine, found.team.data) || (role === 'admin' && !can.manageInvites(mine))) return fail(c, 403, 'forbidden', 'You cannot invite people to this team.');

    if ((await all<Member>(db, membersOf(teamId))).some(member => member.data.email === email)) return fail(c, 409, 'conflict', 'This person is already a member.');
    const pending = await all<Invite>(db, invitesOf(teamId));
    // An address invited again gets a fresh link; expired invitations are cleared on the way.
    for (const old of pending.filter(invite => invite.data.email === email || expired(invite))) await ignoreGone(db.remove(invitesOf(teamId), old.id, old.version));
    if (pending.filter(invite => invite.data.email !== email && !expired(invite)).length >= MAX_PENDING) return fail(c, 409, 'conflict', 'This team has too many pending invitations. Revoke some first.');
    const parsed = Number.parseInt(c.env.INVITE_DAILY_LIMIT ?? '', 10);
    const limit = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_LIMIT;
    if (!(await takeQuota(db, teamId, limit))) return fail(c, 429, 'rate_limited', 'This team has sent the most invitations allowed today.');

    const secret = randomToken();
    const invite = await db.create<Invite>(invitesOf(teamId), {
      email,
      role,
      tokenHash: await sha256(secret),
      invitedBy: user.id,
      expiresAt: new Date(Date.now() + VALID_FOR_MS).toISOString(),
    });
    const link = `${new URL(c.req.url).origin}/#invite=${teamId}.${invite.id}.${secret}`;
    const problem = await sendInvite(c.env, email, found.team.data.name, found.member.data.email, link);
    // The link is answered too, so the inviter can pass it on when no email could be sent.
    return c.json({ invite: inviteView(invite), link, mailed: problem === null, note: problem }, 201);
  },
);

invites.delete('/teams/:teamId/invites/:inviteId', params(z.object({ teamId: recordId, inviteId: recordId })), async c => {
  const db = await store(c.env);
  const { teamId, inviteId } = c.req.valid('param');
  const found = await membership(db, c.get('user').id, teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  if (!can.manageInvites(found.member.data.role)) return fail(c, 403, 'forbidden', 'Only the owner and admins can revoke invitations.');
  const invite = await db.get<Invite>(invitesOf(teamId), inviteId);
  if (invite) await ignoreGone(db.remove(invitesOf(teamId), invite.id, invite.version));
  return c.body(null, 204);
});

const TOKEN = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/;

invites.post('/invites/accept', body(z.strictObject({ token: z.string().max(400).regex(TOKEN, 'not a valid invitation') })), async c => {
  const user = c.get('user');
  const db = await store(c.env);
  const [, teamId, inviteId, secret] = TOKEN.exec(c.req.valid('json').token)!;
  const invite = await db.get<Invite>(invitesOf(teamId), inviteId);
  if (!invite || expired(invite) || !safeEqual(invite.data.tokenHash, await sha256(secret))) {
    return fail(c, 404, 'not_found', 'This invitation is no longer valid. Ask for a new one.');
  }
  const email = await identityEmail(c.env, c.req.url, user.identityToken);
  if (email !== invite.data.email) return fail(c, 403, 'forbidden', `This invitation is for ${invite.data.email}. Sign in with that address to accept it.`);
  const entries = await all<TeamIndex>(db, await indexOf(user.id));
  if (!entries.some(entry => entry.data.teamId === teamId)) {
    // Keyed on the invitation: accepting twice at once adds the user once.
    await addMember(db, teamId, { userId: user.id, email, role: invite.data.role }, `accept-${inviteId}`);
  }
  await ignoreGone(db.remove(invitesOf(teamId), invite.id, invite.version));
  return c.json({ teamId });
});

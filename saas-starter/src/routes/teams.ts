// Teams: create one, list yours, read it, change its settings, delete it; and its members:
// list them, change a role, remove someone or leave.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.ts';
import { fail } from '../errors.ts';
import { identityEmail, type StoredRecord } from '../mdrn.ts';
import { store, TEAMS } from '../store.ts';
import { addMember, all, can, ignoreGone, invitesOf, membersOf, membership, myTeams, removeMember, type Member, type Team } from '../teams.ts';
import { body, params, query, recordId, version } from '../validate.ts';

const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'must be one line');
const timezone = z.string().max(64).refine(zone => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'not a known time zone');
const settings = z.strictObject({
  name: oneLine(80),
  description: z.string().trim().max(500),
  timezone,
  membersCanInvite: z.boolean(),
});

/** What a client sees of a team, with the caller's role in it. */
const teamView = (team: StoredRecord<Team>, role: Member['role']) => ({
  id: team.id,
  version: team.version,
  name: team.data.name,
  description: team.data.description,
  timezone: team.data.timezone,
  membersCanInvite: team.data.membersCanInvite,
  role,
  createdAt: team.createdAt,
});
const memberView = (member: StoredRecord<Member>) => ({ id: member.id, version: member.version, userId: member.data.userId, email: member.data.email, role: member.data.role });

const teamParam = z.object({ teamId: recordId });
const memberParam = z.object({ teamId: recordId, memberId: recordId });

export const teams = new Hono<AppEnv>();

teams.get('/', async c => {
  const mine = await myTeams(await store(c.env), c.get('user').id);
  return c.json({ items: mine.map(({ team, member }) => teamView(team, member.data.role)) });
});

teams.post('/', body(z.strictObject({ name: oneLine(80) })), async c => {
  const user = c.get('user');
  const db = await store(c.env);
  const team = await db.create<Team>(TEAMS, { name: c.req.valid('json').name, description: '', timezone: 'UTC', membersCanInvite: false, createdBy: user.id });
  const email = await identityEmail(c.env, c.req.url, user.identityToken);
  await addMember(db, team.id, { userId: user.id, email, role: 'owner' }, `owner-${team.id}`);
  return c.json(teamView(team, 'owner'), 201);
});

teams.get('/:teamId', params(teamParam), async c => {
  const found = await membership(await store(c.env), c.get('user').id, c.req.valid('param').teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  return c.json(teamView(found.team, found.member.data.role));
});

// Settings: the client sends the version it last read, so two admins never overwrite each other.
teams.put('/:teamId/settings', params(teamParam), body(settings.extend({ version })), async c => {
  const db = await store(c.env);
  const found = await membership(db, c.get('user').id, c.req.valid('param').teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  if (!can.editSettings(found.member.data.role)) return fail(c, 403, 'forbidden', 'Only the owner and admins can change settings.');
  const { version: expected, ...changes } = c.req.valid('json');
  const updated = await db.update<Team>(TEAMS, found.team.id, changes, expected);
  return c.json(teamView(updated, found.member.data.role));
});

// Deleting a team removes its members' access first, then its invitations, then the team.
teams.delete('/:teamId', params(teamParam), query(z.strictObject({ version: z.coerce.number().pipe(version) })), async c => {
  const db = await store(c.env);
  const { teamId } = c.req.valid('param');
  const found = await membership(db, c.get('user').id, teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  if (!can.deleteTeam(found.member.data.role)) return fail(c, 403, 'forbidden', 'Only the owner can delete the team.');
  if (found.team.version !== c.req.valid('query').version) return fail(c, 409, 'conflict', 'This changed since you loaded it. Reload and try again.');
  for (const member of await all<Member>(db, membersOf(teamId))) await removeMember(db, teamId, member);
  for (const invite of await all(db, invitesOf(teamId))) await ignoreGone(db.remove(invitesOf(teamId), invite.id, invite.version));
  await ignoreGone(db.remove(TEAMS, teamId, found.team.version));
  return c.body(null, 204);
});

teams.get('/:teamId/members', params(teamParam), async c => {
  const db = await store(c.env);
  const { teamId } = c.req.valid('param');
  if (!(await membership(db, c.get('user').id, teamId))) return fail(c, 404, 'not_found', 'Team not found.');
  return c.json({ items: (await all<Member>(db, membersOf(teamId))).map(memberView) });
});

teams.patch('/:teamId/members/:memberId', params(memberParam), body(z.strictObject({ version, role: z.enum(['admin', 'member']) })), async c => {
  const db = await store(c.env);
  const { teamId, memberId } = c.req.valid('param');
  const found = await membership(db, c.get('user').id, teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  if (!can.changeRoles(found.member.data.role)) return fail(c, 403, 'forbidden', 'Only the owner can change roles.');
  const target = await db.get<Member>(membersOf(teamId), memberId);
  if (!target) return fail(c, 404, 'not_found', 'Member not found.');
  if (target.data.role === 'owner') return fail(c, 403, 'forbidden', "The owner's role cannot be changed.");
  const { version: expected, role } = c.req.valid('json');
  return c.json(memberView(await db.update<Member>(membersOf(teamId), memberId, { role }, expected)));
});

// Removing someone, or yourself (leaving). The owner cannot leave: they delete the team instead.
teams.delete('/:teamId/members/:memberId', params(memberParam), async c => {
  const db = await store(c.env);
  const { teamId, memberId } = c.req.valid('param');
  const found = await membership(db, c.get('user').id, teamId);
  if (!found) return fail(c, 404, 'not_found', 'Team not found.');
  const target = await db.get<Member>(membersOf(teamId), memberId);
  if (!target) return fail(c, 404, 'not_found', 'Member not found.');
  const leaving = target.id === found.member.id;
  if (leaving ? target.data.role === 'owner' : !can.remove(found.member.data.role, target.data.role)) {
    return fail(c, 403, 'forbidden', leaving ? 'The owner cannot leave. Delete the team instead.' : 'You cannot remove this member.');
  }
  await removeMember(db, teamId, target);
  return c.body(null, 204);
});

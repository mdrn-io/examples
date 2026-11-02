// Teams, their members and who may do what. The routes in src/routes call these.
//
// Where things live (collections in whichever database src/store.ts chose):
//   teams                  one record per team: its name and settings
//   members_<teamId>       one record per member: user id, email, role. The only place a role
//                          is kept, and the one every permission check reads.
//   teams_<userKey>        one record per team a user belongs to: which team, which member
//                          record. It lets "my teams" read only the user's own entries.
//   invites_<teamId>       pending invitations (src/routes/invites.ts)
//
// Every check reads the member record and compares its user id with the signed-in user's, so an
// index entry that points at the wrong team or member grants nothing.
import { userKey } from './crypto.ts';
import { ProductError, type StoredRecord } from './mdrn.ts';
import type { Store } from './store.ts';
import { TEAMS } from './store.ts';

export type Role = 'owner' | 'admin' | 'member';

export interface Team {
  name: string;
  description: string;
  /** An IANA time zone, such as Europe/Ljubljana. */
  timezone: string;
  /** Whether members (not only owners and admins) may invite people, as members. */
  membersCanInvite: boolean;
  createdBy: string;
}

export interface Member {
  userId: string;
  email: string | null;
  role: Role;
}

export interface TeamIndex {
  teamId: string;
  memberId: string;
}

export const membersOf = (teamId: string) => `members_${teamId}`;
export const invitesOf = (teamId: string) => `invites_${teamId}`;
export const indexOf = async (userId: string) => `teams_${await userKey(userId)}`;

/** What a role may do. One table, so the rules are read in one place. */
export const can = {
  editSettings: (role: Role) => role === 'owner' || role === 'admin',
  invite: (role: Role, team: Team) => role !== 'member' || team.membersCanInvite,
  /** Invite as an admin, see and revoke pending invitations. */
  manageInvites: (role: Role) => role === 'owner' || role === 'admin',
  changeRoles: (role: Role) => role === 'owner',
  /** Remove someone else: the owner anyone, an admin only members. The owner is never removed. */
  remove: (role: Role, target: Role) => target !== 'owner' && (role === 'owner' || (role === 'admin' && target === 'member')),
  deleteTeam: (role: Role) => role === 'owner',
};

/** Every record of a collection, a page at a time. Teams are small; a bigger app would page. */
export async function all<T>(store: Store, collection: string): Promise<StoredRecord<T>[]> {
  const items: StoredRecord<T>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list<T>(collection, { limit: 200, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/** The user's index entry for a team, or undefined. */
async function indexEntry(store: Store, userId: string, teamId: string) {
  return (await all<TeamIndex>(store, await indexOf(userId))).find(entry => entry.data.teamId === teamId);
}

export interface Membership {
  team: StoredRecord<Team>;
  member: StoredRecord<Member>;
}

/** The team and the signed-in user's member record in it, or null when they are not a member.
 * A team they are not in answers exactly like one that does not exist, so ids reveal nothing. */
export async function membership(store: Store, userId: string, teamId: string): Promise<Membership | null> {
  const entry = await indexEntry(store, userId, teamId);
  if (!entry) return null;
  const [team, member] = await Promise.all([store.get<Team>(TEAMS, teamId), store.get<Member>(membersOf(teamId), entry.data.memberId)]);
  if (!team || !member || member.data.userId !== userId) return null;
  return { team, member };
}

/** The teams the user belongs to, with their role in each. Entries left behind by a removal that
 * stopped halfway are skipped. */
export async function myTeams(store: Store, userId: string): Promise<Membership[]> {
  const entries = await all<TeamIndex>(store, await indexOf(userId));
  const found = await Promise.all(
    entries.map(async entry => {
      const [team, member] = await Promise.all([store.get<Team>(TEAMS, entry.data.teamId), store.get<Member>(membersOf(entry.data.teamId), entry.data.memberId)]);
      return team && member && member.data.userId === userId ? { team, member } : null;
    }),
  );
  return found.filter(m => m !== null);
}

/** Adds a user to a team: the member record first (it is what grants), then their index entry.
 * `key` makes a retry name the same records instead of adding the user twice. */
export async function addMember(store: Store, teamId: string, member: Member, key: string): Promise<StoredRecord<Member>> {
  const record = await store.create<Member>(membersOf(teamId), member, `${key}-member`);
  await store.create<TeamIndex>(await indexOf(member.userId), { teamId, memberId: record.id }, `${key}-index`);
  return record;
}

/** Removes a member: the member record first, so access ends even if the index entry stays. */
export async function removeMember(store: Store, teamId: string, member: StoredRecord<Member>) {
  await ignoreGone(store.remove(membersOf(teamId), member.id, member.version));
  const entry = await indexEntry(store, member.data.userId, teamId);
  if (entry) await ignoreGone(store.remove(await indexOf(member.data.userId), entry.id, entry.version));
}

/** A delete that someone else already made is done, not an error. */
export async function ignoreGone(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof ProductError && error.status === 404)) throw error;
  }
}

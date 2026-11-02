// Teams, settings, roles and who may do what.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rate-limit.ts';
import { js } from '../src/ui.ts';
import { call, fakeMdrn, type Caller, type Fake } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

/** A team of three: Alice owns it, Bob is an admin, Carol a member. Dave is in no team. */
async function setup() {
  const fake = fakeMdrn();
  const alice = fake.user('usr_alice', 'alice@example.com');
  const bob = fake.user('usr_bob', 'bob@example.com');
  const carol = fake.user('usr_carol', 'carol@example.com');
  const dave = fake.user('usr_dave', 'dave@example.com');
  const team = (await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice)).body;
  await join(fake, team.id, alice, bob, 'bob@example.com', 'admin');
  await join(fake, team.id, alice, carol, 'carol@example.com', 'member');
  return { fake, team, alice, bob, carol, dave };
}

export async function join(fake: Fake, teamId: string, inviter: Caller, who: Caller, email: string, role: 'admin' | 'member') {
  const invite = await call(fake, 'POST', `/api/teams/${teamId}/invites`, { email, role }, inviter);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const token = invite.body.link.split('#invite=')[1];
  const accepted = await call(fake, 'POST', '/api/invites/accept', { token }, who);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

const members = async (fake: Fake, teamId: string, who: Caller) => (await call(fake, 'GET', `/api/teams/${teamId}/members`, undefined, who)).body.items;

test('a user creates a team, owns it and sees it in their list', async () => {
  const fake = fakeMdrn();
  const alice = fake.user('usr_alice', 'alice@example.com');
  const created = await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice);
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'owner');
  const list = await call(fake, 'GET', '/api/teams', undefined, alice);
  assert.deepEqual(list.body.items.map((t: any) => [t.name, t.role]), [['Acme', 'owner']]);
  assert.deepEqual((await members(fake, created.body.id, alice)).map((m: any) => [m.email, m.role]), [['alice@example.com', 'owner']]);
});

test('each member sees the team with their own role; others see nothing', async () => {
  const { fake, team, bob, carol, dave } = await setup();
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, bob)).body.role, 'admin');
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, carol)).body.role, 'member');
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, dave)).status, 404, 'a team you are not in does not exist');
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}/members`, undefined, dave)).status, 404);
  assert.deepEqual((await call(fake, 'GET', '/api/teams', undefined, dave)).body.items, []);
});

test('owner and admins change settings; members cannot; a stale version is refused', async () => {
  const { fake, team, bob, carol } = await setup();
  const settings = { name: 'Acme Inc', description: 'Rockets', timezone: 'Europe/Ljubljana', membersCanInvite: true };
  const changed = await call(fake, 'PUT', `/api/teams/${team.id}/settings`, { version: 1, ...settings }, bob);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.timezone, 'Europe/Ljubljana');
  assert.equal(changed.body.version, 2);
  assert.equal((await call(fake, 'PUT', `/api/teams/${team.id}/settings`, { version: 2, ...settings }, carol)).status, 403);
  assert.equal((await call(fake, 'PUT', `/api/teams/${team.id}/settings`, { version: 1, ...settings }, bob)).status, 409);
  assert.equal((await call(fake, 'PUT', `/api/teams/${team.id}/settings`, { version: 2, ...settings, timezone: 'Mars/Base' }, bob)).status, 400);
});

test('only the owner changes roles, and the owner role is never given or taken', async () => {
  const { fake, team, alice, bob } = await setup();
  const list = await members(fake, team.id, alice);
  const carol = list.find((m: any) => m.email === 'carol@example.com');
  const owner = list.find((m: any) => m.role === 'owner');
  assert.equal((await call(fake, 'PATCH', `/api/teams/${team.id}/members/${carol.id}`, { version: carol.version, role: 'admin' }, bob)).status, 403);
  const promoted = await call(fake, 'PATCH', `/api/teams/${team.id}/members/${carol.id}`, { version: carol.version, role: 'admin' }, alice);
  assert.equal(promoted.body.role, 'admin');
  assert.equal((await call(fake, 'PATCH', `/api/teams/${team.id}/members/${carol.id}`, { version: promoted.body.version, role: 'owner' }, alice)).status, 400);
  assert.equal((await call(fake, 'PATCH', `/api/teams/${team.id}/members/${owner.id}`, { version: owner.version, role: 'member' }, alice)).status, 403);
});

test('removing and leaving follow the roles', async () => {
  const { fake, team, alice, bob, carol } = await setup();
  const list = await members(fake, team.id, alice);
  const id = (email: string) => list.find((m: any) => m.email === email).id;
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/members/${id('bob@example.com')}`, undefined, carol)).status, 403, 'a member removes nobody');
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/members/${id('alice@example.com')}`, undefined, bob)).status, 403, 'nobody removes the owner');
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/members/${id('alice@example.com')}`, undefined, alice)).status, 403, 'the owner cannot leave');
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/members/${id('carol@example.com')}`, undefined, bob)).status, 204, 'an admin removes a member');
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, carol)).status, 404, 'access ends at once');
  assert.deepEqual((await call(fake, 'GET', '/api/teams', undefined, carol)).body.items, []);
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/members/${id('bob@example.com')}`, undefined, bob)).status, 204, 'anyone else can leave');
  assert.deepEqual((await members(fake, team.id, alice)).map((m: any) => m.email), ['alice@example.com']);
});

test('only the owner deletes the team, and every member loses it', async () => {
  const { fake, team, alice, bob, carol } = await setup();
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}?version=1`, undefined, bob)).status, 403);
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}?version=1`, undefined, alice)).status, 204);
  for (const who of [alice, bob, carol]) {
    assert.deepEqual((await call(fake, 'GET', '/api/teams', undefined, who)).body.items, []);
    assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, who)).status, 404);
  }
});

test('sign-in, the Origin check and input validation guard every route', async () => {
  const fake = fakeMdrn();
  const alice = fake.user('usr_alice');
  assert.equal((await call(fake, 'GET', '/api/teams')).status, 401);
  assert.equal((await call(fake, 'POST', '/api/teams', { name: 'Acme' }, { ...alice, origin: 'https://other.apps.mdrn.io' })).status, 403);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'two\nlines' }, { name: 'ok', role: 'owner' }]) {
    assert.equal((await call(fake, 'POST', '/api/teams', body, alice)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(fake, 'GET', '/api/teams/bad%20id', undefined, alice)).status, 400);
  // Without MDRN in front (no MDRN_PRODUCTS binding) the sign-in headers are not trusted.
  const local = fakeMdrn({ settings: { MDRN_PRODUCTS: undefined } });
  assert.equal((await call(local, 'GET', '/api/teams', undefined, local.user('usr_alice'))).status, 401);
});

test('the frontend and readiness answer without sign-in', async () => {
  const fake = fakeMdrn();
  const page = await call(fake, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type')!, /text\/html/);
  assert.match(page.headers.get('Content-Security-Policy')!, /script-src 'self'/);
  assert.equal((await call(fake, 'GET', '/app.js')).status, 200);
  assert.doesNotThrow(() => new Function(js), 'the script parses');
  assert.equal((await call(fake, 'GET', '/app.css')).status, 200);
  assert.deepEqual((await call(fake, 'GET', '/health')).body, { ok: true });
});

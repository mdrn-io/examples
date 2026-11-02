// Invitations go out by email and are accepted by the invited address only.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rate-limit.ts';
import { call, fakeMdrn, type FakeOptions } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

async function setup(options: FakeOptions = {}) {
  const fake = fakeMdrn(options);
  const alice = fake.user('usr_alice', 'alice@example.com');
  const bob = fake.user('usr_bob', 'bob@example.com');
  const team = (await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice)).body;
  return { fake, alice, bob, team };
}

const tokenOf = (link: string) => link.split('#invite=')[1];

test('an invitation is mailed with a link, and the invited user joins with the role given', async () => {
  const { fake, alice, bob, team } = await setup();
  const invite = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'Bob@Example.com', role: 'admin' }, alice);
  assert.equal(invite.status, 201);
  assert.equal(invite.body.mailed, true);
  assert.equal(invite.body.invite.email, 'bob@example.com');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].recipient, 'bob@example.com');
  assert.ok(fake.sent[0].text.includes(invite.body.link), 'the mail carries the link');
  assert.ok(fake.sent[0].text.includes('alice@example.com'), 'and says who invited');
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}/invites`, undefined, alice)).body.items.length, 1);

  const accepted = await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(invite.body.link) }, bob);
  assert.deepEqual(accepted.body, { teamId: team.id });
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, bob)).body.role, 'admin');
  assert.deepEqual((await call(fake, 'GET', `/api/teams/${team.id}/invites`, undefined, alice)).body.items, [], 'the invitation is used up');
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(invite.body.link) }, bob)).status, 404, 'and works once');
});

test('only the invited address can accept, and a guessed token is refused', async () => {
  const { fake, alice, team } = await setup();
  const invite = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'bob@example.com' }, alice);
  const mallory = fake.user('usr_mallory', 'mallory@example.com');
  const token = tokenOf(invite.body.link);
  const wrong = await call(fake, 'POST', '/api/invites/accept', { token }, mallory);
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error.message, /bob@example\.com/);
  const guessed = token.slice(0, -4) + 'AAAA';
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: guessed }, fake.user('usr_bob', 'bob@example.com'))).status, 404);
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: 'nonsense' }, mallory)).status, 400);
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}`, undefined, mallory)).status, 404);
});

test('in build mode the invitation is made and its link answered, though no mail can go', async () => {
  const { fake, alice, bob, team } = await setup({ postgres: 'build', mailOnlyTo: ['alice@example.com'] });
  const invite = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'bob@example.com' }, alice);
  assert.equal(invite.status, 201);
  assert.equal(invite.body.mailed, false);
  assert.match(invite.body.note, /build mode/);
  assert.equal(fake.sent.length, 0);
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(invite.body.link) }, bob)).status, 200);
});

test('members invite only when the team allows it, and never as admins', async () => {
  const { fake, alice, bob, team } = await setup();
  const invite = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'bob@example.com' }, alice);
  await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(invite.body.link) }, bob);
  assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'carol@example.com' }, bob)).status, 403);
  await call(fake, 'PUT', `/api/teams/${team.id}/settings`, { version: 1, name: 'Acme', description: '', timezone: 'UTC', membersCanInvite: true }, alice);
  assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'carol@example.com' }, bob)).status, 201);
  assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'dan@example.com', role: 'admin' }, bob)).status, 403);
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}/invites`, undefined, bob)).status, 403);
});

test('a member is not invited again; an address invited again gets a fresh link; a revoked one stops', async () => {
  const { fake, alice, bob, team } = await setup();
  assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'alice@example.com' }, alice)).status, 409);
  const first = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'bob@example.com' }, alice);
  const second = await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'bob@example.com' }, alice);
  assert.equal((await call(fake, 'GET', `/api/teams/${team.id}/invites`, undefined, alice)).body.items.length, 1);
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(first.body.link) }, bob)).status, 404);
  assert.equal((await call(fake, 'DELETE', `/api/teams/${team.id}/invites/${second.body.invite.id}`, undefined, alice)).status, 204);
  assert.equal((await call(fake, 'POST', '/api/invites/accept', { token: tokenOf(second.body.link) }, bob)).status, 404);
});

test('a team sends at most INVITE_DAILY_LIMIT invitations a day', async () => {
  const { fake, alice, team } = await setup({ settings: { INVITE_DAILY_LIMIT: '2' } });
  for (const name of ['a', 'b']) assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: `${name}@example.com` }, alice)).status, 201);
  assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, { email: 'c@example.com' }, alice)).status, 429);
  assert.equal(fake.sent.length, 2);
});

test('an invitation body takes an address and a role, nothing else', async () => {
  const { fake, alice, team } = await setup();
  for (const body of [{}, { email: 'not an address' }, { email: 'b@example.com', role: 'owner' }, { email: 'b@example.com', subject: 'Hi' }]) {
    assert.equal((await call(fake, 'POST', `/api/teams/${team.id}/invites`, body, alice)).status, 400, JSON.stringify(body));
  }
  assert.equal(fake.sent.length, 0);
});

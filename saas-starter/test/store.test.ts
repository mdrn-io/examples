// The app keeps its data in Postgres when the project has it, and in SQLite otherwise.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rate-limit.ts';
import { call, fakeMdrn, type FakeOptions } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

async function teamIn(options: FakeOptions) {
  const fake = fakeMdrn(options);
  const alice = fake.user('usr_alice', 'alice@example.com');
  const created = await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice);
  const me = await call(fake, 'GET', '/api/me', undefined, alice);
  return { fake, alice, created, me };
}

test('a live project with Postgres keeps its teams in Postgres', async () => {
  const { fake, created, me } = await teamIn({ postgres: 'live' });
  assert.equal(created.status, 201);
  assert.equal(me.body.store, 'postgres');
  assert.ok(fake.databases.POSTGRES.get('teams')?.has(created.body.id));
  assert.equal(fake.databases.SQLITE.get('teams')?.size ?? 0, 0);
});

test('build mode, where Postgres answers 402, uses SQLite with no edits', async () => {
  const { fake, created, me } = await teamIn({ postgres: 'build' });
  assert.equal(created.status, 201);
  assert.equal(me.body.store, 'sqlite');
  assert.ok(fake.databases.SQLITE.get('teams')?.has(created.body.id));
});

test('a project with Postgres off uses SQLite', async () => {
  const { fake, me } = await teamIn({ postgres: 'off' });
  assert.equal(me.body.store, 'sqlite');
  assert.equal(fake.calls.POSTGRES, 0, 'Postgres is never called');
});

test('teams made in SQLite stay there once Postgres arrives', async () => {
  const fake = fakeMdrn({ postgres: 'live' });
  const now = new Date().toISOString();
  fake.databases.SQLITE.set('teams', new Map([['rec_old', { id: 'rec_old', collection: 'teams', version: 1, data: { name: 'Made in build mode' }, createdAt: now, updatedAt: now }]]));
  const me = await call(fake, 'GET', '/api/me', undefined, fake.user('usr_alice'));
  assert.equal(me.body.store, 'sqlite');
  assert.equal(fake.calls.POSTGRES, 0);
});

test('DATA_STORE chooses the database', async () => {
  const { me } = await teamIn({ postgres: 'live', settings: { DATA_STORE: 'sqlite' } });
  assert.equal(me.body.store, 'sqlite');
});

test('a Postgres database that is still starting is Postgres', async () => {
  const fake = fakeMdrn({ postgres: 'starting' });
  const alice = fake.user('usr_alice');
  const me = await call(fake, 'GET', '/api/me', undefined, alice);
  assert.equal(me.body.store, 'postgres');
  const created = await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice);
  assert.equal(created.status, 201);
  assert.ok(fake.databases.POSTGRES.get('teams')?.has(created.body.id));
});

test('while Postgres starts, the client is asked to retry in a few seconds', async () => {
  const fake = fakeMdrn({ postgres: 'starting', settings: { DATA_STORE: 'postgres' } });
  const alice = fake.user('usr_alice');
  const first = await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('Retry-After'), '5');
  assert.equal((await call(fake, 'POST', '/api/teams', { name: 'Acme' }, alice)).status, 201);
});

test('the choice is made once per Worker instance', async () => {
  const fake = fakeMdrn({ postgres: 'live' });
  const alice = fake.user('usr_alice');
  await call(fake, 'GET', '/api/me', undefined, alice);
  const before = { ...fake.calls };
  await call(fake, 'GET', '/api/me', undefined, alice);
  assert.deepEqual(fake.calls, before, 'no database call to choose again');
});

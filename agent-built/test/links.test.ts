// Signed-in users make, list and delete their own short links, and nobody else's.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rate-limit.ts';
import { call, fakeMdrn, ORIGIN } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

const alice = { user: 'usr_alice' };
const bob = { user: 'usr_bob' };

test('a user makes a link with their own code, lists it and deletes it', async () => {
  const fake = fakeMdrn();
  const made = await call(fake, 'POST', '/api/links', { url: 'https://example.com/a/long/page', code: 'promo' }, alice);
  assert.equal(made.status, 201);
  assert.equal(made.body.shortUrl, `${ORIGIN}/s/promo`);
  assert.equal(made.body.clicks, 0);
  assert.equal(made.body.ownerId, undefined, 'the owner is not echoed back');

  const list = await call(fake, 'GET', '/api/links', undefined, alice);
  assert.deepEqual(list.body.items.map((l: any) => [l.code, l.url]), [['promo', 'https://example.com/a/long/page']]);
  assert.equal(list.headers.get('Cache-Control'), 'private, no-store');

  assert.equal((await call(fake, 'DELETE', `/api/links/${made.body.id}`, undefined, alice)).status, 204);
  assert.deepEqual((await call(fake, 'GET', '/api/links', undefined, alice)).body.items, []);
  assert.equal((await call(fake, 'GET', '/s/promo')).status, 404);
  assert.equal((await call(fake, 'POST', '/api/links', { url: 'https://example.org/', code: 'promo' }, bob)).status, 201, 'the code is free again');
});

test('without a code, a random one of 7 characters is made', async () => {
  const fake = fakeMdrn();
  const made = await call(fake, 'POST', '/api/links', { url: 'http://example.com/' }, alice);
  assert.equal(made.status, 201);
  assert.match(made.body.code, /^[a-z0-9]{7}$/);
});

test('a code someone already has is refused', async () => {
  const fake = fakeMdrn();
  await call(fake, 'POST', '/api/links', { url: 'https://example.com/', code: 'promo' }, alice);
  const taken = await call(fake, 'POST', '/api/links', { url: 'https://example.org/', code: 'promo' }, bob);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'code_taken');
  assert.deepEqual((await call(fake, 'GET', '/api/links', undefined, bob)).body.items, []);
});

test('of two claims racing for one code, the one created first keeps it', async () => {
  const fake = fakeMdrn();
  // Carol's claim lands between Bob's check and Bob's write, and was created before Bob's.
  fake.state.afterCreate = record => {
    fake.state.afterCreate = undefined;
    const rival = fake.insert(record.collection, { ownerId: 'usr_carol', url: 'https://carol.example/', clicks: 0 });
    rival.createdAt = '2026-01-01T00:00:00.000Z';
  };
  const lost = await call(fake, 'POST', '/api/links', { url: 'https://example.org/', code: 'race' }, bob);
  assert.equal(lost.status, 409);
  assert.equal(fake.collections.get('link_race')!.size, 1, "Bob's record was taken back");
  assert.equal((await call(fake, 'GET', '/s/race')).headers.get('Location'), 'https://carol.example/');
});

test('a later record with a lower id does not take over a code', async () => {
  const fake = fakeMdrn();
  await call(fake, 'POST', '/api/links', { url: 'https://example.com/', code: 'first' }, alice);
  fake.insert('link_first', { ownerId: 'usr_bob', url: 'https://bob.example/', clicks: 0 }, 'rec_0');
  assert.equal((await call(fake, 'GET', '/s/first')).headers.get('Location'), 'https://example.com/');
});

test('bad links and codes are refused before anything is stored', async () => {
  const fake = fakeMdrn();
  for (const body of [
    {},
    { url: 'not a url' },
    { url: 'javascript:alert(1)' },
    { url: 'ftp://example.com/' },
    { url: 'https://user:secret@example.com/' },
    { url: `${ORIGIN}/s/loop` },
    { url: 'https://example.com/', code: 'ab' },
    { url: 'https://example.com/', code: 'Has_Caps' },
    { url: 'https://example.com/', code: 'api' },
    { url: 'https://example.com/', code: 'health' },
    { url: 'https://example.com/', ownerId: 'usr_bob' },
    { url: `https://example.com/${'x'.repeat(2048)}` },
  ]) {
    const response = await call(fake, 'POST', '/api/links', body, alice);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(response.body.error.code, 'invalid_request');
  }
  assert.equal(fake.collections.size, 0, 'nothing was stored');
});

test('another user cannot see or delete my links', async () => {
  const fake = fakeMdrn();
  const made = (await call(fake, 'POST', '/api/links', { url: 'https://example.com/', code: 'mine' }, alice)).body;
  assert.deepEqual((await call(fake, 'GET', '/api/links', undefined, bob)).body.items, []);
  assert.equal((await call(fake, 'DELETE', `/api/links/${made.id}`, undefined, bob)).status, 404);
  assert.equal((await call(fake, 'GET', '/s/mine')).status, 302, 'the link still works');
});

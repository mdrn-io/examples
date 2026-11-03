// Sign-in, the page, readiness and the SQLite client's safety rules.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.ts';
import { ProductError, sqlite } from '../src/mdrn.ts';
import { resetRateLimits } from '../src/rate-limit.ts';
import { call, fakeMdrn, ORIGIN } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

test('the API needs a signed-in user', async () => {
  const fake = fakeMdrn();
  const response = await call(fake, 'GET', '/api/links');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'unauthenticated');
});

test("sign-in headers are ignored when the Worker is not running on MDRN", async () => {
  const headers = { 'x-mdrn-user-id': 'usr_alice', 'x-mdrn-identity-token': 'idt' };
  const response = await app.fetch(new Request(`${ORIGIN}/api/links`, { headers }), {});
  assert.equal(response.status, 401);
});

test('a write from another origin is refused', async () => {
  const fake = fakeMdrn();
  for (const origin of ['https://other.apps.mdrn.io', null]) {
    const response = await call(fake, 'POST', '/api/links', { url: 'https://example.com/' }, { user: 'usr_alice', origin });
    assert.equal(response.status, 403, String(origin));
  }
  assert.equal(fake.collections.size, 0);
});

test('the page loads its own script and style, and allows no inline script', async () => {
  const fake = fakeMdrn();
  const page = await call(fake, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type')!, /^text\/html/);
  assert.match(page.headers.get('Content-Security-Policy')!, /script-src 'self'/);
  assert.doesNotMatch(page.body, /<script>/);
  assert.match(page.body, /href="\/login"/);
  assert.match((await call(fake, 'GET', '/app.js')).headers.get('Content-Type')!, /^text\/javascript/);
  assert.equal((await call(fake, 'GET', '/app.css')).status, 200);
  assert.deepEqual((await call(fake, 'GET', '/health')).body, { ok: true });
});

test('the SQLite client refuses a redirect and sends its token only over https', async () => {
  let calls = 0;
  const env = (url: string) => ({
    MDRN_PRODUCTS: {
      fetch: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } });
      },
    },
    MDRN_SQLITE_URL: url,
    MDRN_SQLITE_TOKEN: 'mdrn_product_sqlite',
  });
  await assert.rejects(sqlite.list(env(`${ORIGIN}/_mdrn/v1/sqlite`), 'links'), (e: unknown) => e instanceof ProductError && e.code === 'UNEXPECTED_REDIRECT');
  await assert.rejects(sqlite.list(env('http://links.example.apps.mdrn.io/_mdrn/v1/sqlite'), 'links'), /must be an https URL/);
  assert.equal(calls, 1);
});

test('with SQLite off, the API says so in its own words', async () => {
  const fake = fakeMdrn();
  delete fake.env.MDRN_SQLITE_TOKEN;
  const response = await call(fake, 'GET', '/api/links', undefined, { user: 'usr_alice' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'unavailable');
});

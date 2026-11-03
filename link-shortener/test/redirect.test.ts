// Anyone follows a short link; the click is counted, but counting never blocks the redirect.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rate-limit.ts';
import { call, fakeMdrn } from './fake-mdrn.ts';

beforeEach(() => resetRateLimits());

const alice = { user: 'usr_alice' };

async function withLink() {
  const fake = fakeMdrn();
  await call(fake, 'POST', '/api/links', { url: 'https://example.com/page?x=1', code: 'gogo' }, alice);
  return fake;
}

test('following a link redirects without caching and counts the click', async () => {
  const fake = await withLink();
  for (let i = 0; i < 2; i++) {
    const response = await call(fake, 'GET', '/s/gogo');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://example.com/page?x=1');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await call(fake, 'GET', '/api/links', undefined, alice)).body.items[0].clicks, 2);
});

test('a click that cannot be counted still redirects', async () => {
  const fake = await withLink();
  fake.state.failWrites = true;
  const response = await call(fake, 'GET', '/s/gogo');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://example.com/page?x=1');
  fake.state.failWrites = false;
  assert.equal((await call(fake, 'GET', '/api/links', undefined, alice)).body.items[0].clicks, 0);
});

test('a link that is still being clicked can be deleted', async () => {
  const fake = await withLink();
  const link = (await call(fake, 'GET', '/api/links', undefined, alice)).body.items[0];
  // A click lands between the delete's read and its write, once.
  let raced = false;
  const original = fake.env.MDRN_PRODUCTS!.fetch;
  fake.env.MDRN_PRODUCTS = {
    async fetch(request) {
      if (request.method === 'DELETE' && !raced && request.url.includes('link_gogo')) {
        raced = true;
        const record = [...fake.collections.get('link_gogo')!.values()][0];
        record.version += 1;
      }
      return original(request);
    },
  };
  assert.equal((await call(fake, 'DELETE', `/api/links/${link.id}`, undefined, alice)).status, 204);
  assert.equal(fake.collections.get('link_gogo')!.size, 0);
});

test('an unknown or malformed code answers 404', async () => {
  const fake = await withLink();
  for (const path of ['/s/nope', '/s/BAD', '/s/x']) {
    const response = await call(fake, 'GET', path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('Location'), null);
  }
});

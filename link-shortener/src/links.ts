// Short links, kept in MDRN SQLite records only.
//
// MDRN assigns record ids, so a code cannot be a record id. Instead each code has a collection of
// its own, `link_<code>`, that holds the link as its one record. Two people may claim the same
// code at the same moment and both write a record there; the one created first owns the code
// (see `owner` below), and the other removes theirs and is told the code is taken.
//
// Each user also has an index, `links_<userKey>`, with one small record per link they made, so
// listing their links reads only theirs. Both records store the owner, and every route checks it.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env.ts';
import { fail } from './errors.ts';
import { ProductError, sqlite, type StoredRecord } from './mdrn.ts';
import { rateLimit } from './rate-limit.ts';
import { body, code, params, query, recordId } from './validate.ts';

export interface Link {
  ownerId: string;
  url: string;
  clicks: number;
}

interface IndexEntry {
  ownerId: string;
  code: string;
  linkId: string;
}

/** Codes that would read as one of the app's own paths. */
export const RESERVED = new Set(['api', 'health', 's', 'login', 'logout', 'account', 'app', 'admin', 'static', 'mdrn']);
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const linkCollection = (c: string) => `link_${c}`;

/** A stable, opaque key for a user, used to name their index collection. */
async function userKey(userId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`user:${userId}`)));
  return 'u' + Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}
const indexCollection = async (userId: string) => `links_${await userKey(userId)}`;

/** 7 random characters from a-z0-9, without modulo bias (252 is the largest multiple of 36). */
export function randomCode(): string {
  let out = '';
  while (out.length < 7) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 252 && out.length < 7) out += ALPHABET[byte % 36];
  }
  return out;
}

/** The link that owns a code: of the records in its collection, the one created first (ties by
 * lowest id), or null. There is almost always one record, so this is one small read. */
export async function owner(env: Env, c: string): Promise<StoredRecord<Link> | null> {
  const page = await sqlite.list<Link>(env, linkCollection(c), { limit: 10 });
  const sorted = page.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return sorted[0] ?? null;
}

/** An http(s) URL that does not point back at this app, or a reason it is refused. */
function checkUrl(raw: string, ownHost: string): string | URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url: not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url: only http and https links can be shortened';
  if (url.username || url.password) return 'url: a link may not carry a user name or password';
  if (url.hostname === ownHost) return 'url: a short link may not point back at this app';
  return url;
}

const view = (origin: string, entry: StoredRecord<IndexEntry>, link: StoredRecord<Link>) => ({
  id: entry.id,
  code: entry.data.code,
  shortUrl: `${origin}/s/${entry.data.code}`,
  url: link.data.url,
  clicks: link.data.clicks,
  createdAt: link.createdAt,
});

export const links = new Hono<AppEnv>();

links.get('/', query(z.strictObject({ cursor: z.string().max(2048).optional() })), async c => {
  const user = c.get('user');
  const origin = new URL(c.req.url).origin;
  const page = await sqlite.list<IndexEntry>(c.env, await indexCollection(user.id), { limit: 50, cursor: c.req.valid('query').cursor });
  const entries = page.items.filter(entry => entry.data.ownerId === user.id);
  const found = await Promise.all(entries.map(entry => sqlite.get<Link>(c.env, linkCollection(entry.data.code), entry.data.linkId)));
  const items = entries.flatMap((entry, i) => {
    const link = found[i];
    return link && link.data.ownerId === user.id ? [view(origin, entry, link)] : [];
  });
  return c.json({ items, nextCursor: page.nextCursor });
});

links.post(
  '/',
  rateLimit('create', 30, 60_000, 'user'),
  body(z.strictObject({ url: z.string().trim().min(1).max(2048), code: code.optional() })),
  async c => {
    const user = c.get('user');
    const input = c.req.valid('json');
    const requestUrl = new URL(c.req.url);
    const target = checkUrl(input.url, requestUrl.hostname);
    if (typeof target === 'string') return fail(c, 400, 'invalid_request', target);
    if (input.code && RESERVED.has(input.code)) return fail(c, 400, 'invalid_request', 'code: that code is reserved');

    // A chosen code is tried once; a random one up to three times, should it collide.
    for (let attempt = 0; attempt < (input.code ? 1 : 3); attempt++) {
      const chosen = input.code ?? randomCode();
      if (await owner(c.env, chosen)) continue;
      const link = await sqlite.create<Link>(c.env, linkCollection(chosen), { ownerId: user.id, url: target.href, clicks: 0 });
      if ((await owner(c.env, chosen))?.id !== link.id) {
        // Someone claimed the same code a moment earlier: theirs stands, ours goes.
        await sqlite.remove(c.env, linkCollection(chosen), link.id, link.version);
        continue;
      }
      try {
        const entry = await sqlite.create<IndexEntry>(c.env, await indexCollection(user.id), { ownerId: user.id, code: chosen, linkId: link.id });
        return c.json(view(requestUrl.origin, entry, link), 201);
      } catch (error) {
        // Without its index entry the user could never see or delete the link: take it back.
        await sqlite.remove(c.env, linkCollection(chosen), link.id, link.version).catch(() => {});
        throw error;
      }
    }
    return fail(c, 409, 'code_taken', input.code ? 'That code is taken. Pick another.' : 'Could not find a free code. Try again.');
  },
);

links.delete('/:id', params(z.object({ id: recordId })), async c => {
  const user = c.get('user');
  const index = await indexCollection(user.id);
  const entry = await sqlite.get<IndexEntry>(c.env, index, c.req.valid('param').id);
  if (!entry || entry.data.ownerId !== user.id) return fail(c, 404, 'not_found', 'Link not found.');
  // Clicks raise the link's version, so a delete that meets one reads the link again and retries.
  for (let attempt = 0; ; attempt++) {
    const link = await sqlite.get<Link>(c.env, linkCollection(entry.data.code), entry.data.linkId);
    if (!link || link.data.ownerId !== user.id) break;
    try {
      await sqlite.remove(c.env, linkCollection(entry.data.code), link.id, link.version);
      break;
    } catch (error) {
      if (!(error instanceof ProductError && error.code === 'CONFLICT') || attempt >= 2) throw error;
    }
  }
  await sqlite.remove(c.env, index, entry.id, entry.version);
  return c.body(null, 204);
});

/** GET /s/:code: anyone follows a short link. The click is counted with one optimistic update;
 * a conflict (two clicks at once) or any failure loses that one count, never the redirect. */
export async function follow(c: Context<AppEnv>) {
  const parsed = code.safeParse(c.req.param('code'));
  const link = parsed.success ? await owner(c.env, parsed.data) : null;
  c.header('Cache-Control', 'no-store');
  if (!link) return c.text('This short link does not exist.', 404);
  const count = sqlite.update<Link>(c.env, linkCollection(parsed.data!), link.id, { clicks: link.data.clicks + 1 }, link.version).catch(error => {
    if (!(error instanceof ProductError && error.code === 'CONFLICT')) console.error(JSON.stringify({ event: 'click_not_counted', message: String(error?.message ?? error) }));
  });
  // On MDRN the count finishes after the answer has gone; in tests there is no context to wait on.
  try {
    c.executionCtx.waitUntil(count);
  } catch {
    await count;
  }
  return c.redirect(link.data.url, 302);
}

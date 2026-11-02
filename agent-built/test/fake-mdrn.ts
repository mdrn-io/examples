// An in-memory stand-in for what MDRN gives a release: the MDRN_PRODUCTS binding with SQLite
// records behind it. It follows the real contract closely enough for these tests: a required
// Idempotency-Key on writes, ids derived from that key (so id order says nothing about creation
// order), If-Match versions and cursors. It is not MDRN; the real thing is exercised by deploying.
import { createHash } from 'node:crypto';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';

export const ORIGIN = 'https://links.example.apps.mdrn.io';
const TOKEN = 'mdrn_product_sqlite';

export interface FakeRecord {
  id: string;
  collection: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const error = (status: number, code: string) => json({ error: { code, message: code } }, status);

export function fakeMdrn() {
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const collections = new Map<string, Map<string, FakeRecord>>();
  const replies = new Map<string, Response>();
  const state = {
    /** SQLite writes answer 503 while set. */
    failWrites: false,
    /** Runs after each record is created, before the answer: lets a test race another write in. */
    afterCreate: undefined as ((record: FakeRecord) => void) | undefined,
  };

  const collection = (name: string) => {
    let records = collections.get(name);
    if (!records) collections.set(name, (records = new Map()));
    return records;
  };

  /** Stores a record directly, as another request would. */
  function insert(name: string, data: Record<string, unknown>, id = `rec_${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 20)}`) {
    const now = new Date((clock += 1000)).toISOString();
    const record = { id, collection: name, version: 1, data, createdAt: now, updatedAt: now };
    collection(name).set(id, record);
    return record;
  }

  async function sqlite(request: Request, key: string, path: string[]) {
    const [, name, , id] = path; // collections/<name>/records[/<id>]
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) return error(400, 'INVALID_REQUEST');
    const records = collection(name);
    if (request.method === 'GET' && id === undefined) {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const after = url.searchParams.get('cursor') ?? '';
      const sorted = [...records.values()].sort((a, b) => a.id.localeCompare(b.id)).filter(r => r.id > after);
      const items = sorted.slice(0, limit);
      return json({ items, nextCursor: sorted.length > limit ? items.at(-1)!.id : null });
    }
    if (request.method === 'GET') {
      const record = records.get(id);
      return record ? json(record) : error(404, 'NOT_FOUND');
    }
    if (state.failWrites) return error(503, 'DATABASE_UNAVAILABLE');
    const body: any = request.method === 'DELETE' ? undefined : await request.json();
    if (request.method === 'POST') {
      const record = insert(name, body.data, `rec_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`);
      state.afterCreate?.(record);
      return json(record, 201);
    }
    const record = records.get(id);
    if (!record) return error(404, 'NOT_FOUND');
    if (Number(request.headers.get('If-Match')) !== record.version) return error(409, 'CONFLICT');
    if (request.method === 'DELETE') {
      records.delete(id);
      return json({ deleted: true });
    }
    record.data = { ...record.data, ...body.data };
    record.version += 1;
    record.updatedAt = new Date((clock += 1000)).toISOString();
    return json(record);
  }

  const binding = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/_mdrn/v1/sqlite/')) return error(404, 'NOT_FOUND');
      if (request.headers.get('Authorization') !== `Bearer ${TOKEN}`) return error(401, 'PRODUCT_ACCESS_DENIED');
      const key = request.headers.get('Idempotency-Key') ?? '';
      if (request.method !== 'GET') {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) return error(400, 'INVALID_REQUEST');
        const replay = replies.get(key);
        if (replay) return replay.clone();
      }
      const response = await sqlite(request, key, url.pathname.split('/').filter(Boolean).slice(3));
      if (request.method !== 'GET' && response.ok) replies.set(key, response.clone());
      return response;
    },
  };

  const env: Env = {
    MDRN_PRODUCTS: binding,
    MDRN_PROJECT_ID: 'prj_test',
    MDRN_ENVIRONMENT: 'sandbox',
    MDRN_SQLITE_URL: `${ORIGIN}/_mdrn/v1/sqlite`,
    MDRN_SQLITE_TOKEN: TOKEN,
  };

  return { env, collections, state, insert };
}

export type Fake = ReturnType<typeof fakeMdrn>;

export interface Caller {
  /** A browser signed in through MDRN: Proxy's headers, and this app's own Origin on writes. */
  user?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

/** Sends a request to the app the way Proxy would deliver it. */
export async function call(fake: Fake, method: string, path: string, body?: unknown, who: Caller = {}) {
  const headers = new Headers(who.headers);
  if (who.user) {
    headers.set('x-mdrn-user-id', who.user);
    headers.set('x-mdrn-identity-token', `idt_${who.user}`);
  }
  const origin = who.origin === undefined ? (who.user && method !== 'GET' ? ORIGIN : null) : who.origin;
  if (origin) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), fake.env);
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, body: parsed };
}

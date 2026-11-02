// An in-memory stand-in for what MDRN gives a release: the MDRN_PRODUCTS binding with SQLite and
// Postgres records and Mail behind it, plus the sign-in's /v1/auth/me. It follows the real
// contracts closely enough for these tests: required Idempotency-Key on writes, If-Match versions,
// cursors, Postgres refused in build mode. It is not MDRN; the real thing is exercised by deploying.
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';

export const ORIGIN = 'https://teams.example.apps.mdrn.io';
const TOKENS = { SQLITE: 'mdrn_product_sqlite', POSTGRES: 'mdrn_product_postgres', MAIL: 'mdrn_product_mail' };

interface StoredRecord {
  id: string;
  collection: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const error = (status: number, code: string) => json({ error: { code, message: code } }, status);

export interface FakeOptions {
  /** live: Postgres works. build: build mode, every Postgres call is 402. off: no Postgres
   * bindings. starting: the first call makes it, and is answered 503 DATABASE_STARTING. */
  postgres?: 'live' | 'build' | 'off' | 'starting';
  /** Build mode mail: only these addresses are workspace members; others are refused. */
  mailOnlyTo?: string[];
  settings?: Partial<Env>;
}

export function fakeMdrn(options: FakeOptions = {}) {
  const postgresMode = options.postgres ?? 'live';
  let postgresStarted = postgresMode !== 'starting';
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${String(++sequence).padStart(6, '0')}`;
  const databases = { SQLITE: new Map<string, Map<string, StoredRecord>>(), POSTGRES: new Map<string, Map<string, StoredRecord>>() };
  const replies = new Map<string, Response>();
  const accounts = new Map<string, { id: string; email?: string }>();
  const sent: { recipient: string; subject: string; text: string }[] = [];
  const calls = { SQLITE: 0, POSTGRES: 0 };

  async function records(database: 'SQLITE' | 'POSTGRES', request: Request, path: string[]) {
    const [, name, , id] = path; // collections/<name>/records[/<id>]
    let records = databases[database].get(name);
    if (!records) databases[database].set(name, (records = new Map()));
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
    const body: any = request.method === 'DELETE' ? undefined : await request.json();
    if (request.method === 'POST') {
      const now = new Date().toISOString();
      const record = { id: next('rec'), collection: name, version: 1, data: body.data, createdAt: now, updatedAt: now };
      records.set(record.id, record);
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
    record.updatedAt = new Date().toISOString();
    return json(record);
  }

  const binding = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== ORIGIN) throw new Error(`unexpected origin ${url.origin}`);
      if (url.pathname === '/v1/auth/me' && request.method === 'GET') {
        const account = accounts.get(request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '');
        return account ? json({ id: account.id, email: account.email ?? null }) : error(401, 'UNAUTHENTICATED');
      }
      const product = url.pathname.startsWith('/_mdrn/v1/sqlite/')
        ? 'SQLITE'
        : url.pathname.startsWith('/_mdrn/v1/postgres/')
          ? 'POSTGRES'
          : url.pathname === '/v1/mail/messages'
            ? 'MAIL'
            : null;
      if (!product) return error(404, 'NOT_FOUND');
      if (request.headers.get('Authorization') !== `Bearer ${TOKENS[product]}`) return error(401, 'PRODUCT_ACCESS_DENIED');
      if (product === 'POSTGRES') {
        if (postgresMode === 'build') return error(402, 'BUILD_MODE_GO_LIVE_REQUIRED');
        if (!postgresStarted) {
          postgresStarted = true;
          return error(503, 'DATABASE_STARTING');
        }
      }
      const key = request.headers.get('Idempotency-Key');
      if (request.method !== 'GET') {
        if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) return error(400, 'INVALID_REQUEST');
        const replay = replies.get(`${product}:${key}`);
        if (replay) return replay.clone();
      }
      let response: Response;
      if (product === 'MAIL') {
        const message: any = await request.json();
        if (options.mailOnlyTo && !options.mailOnlyTo.includes(message.recipient)) return error(403, 'BUILD_MAIL_RECIPIENT');
        sent.push({ recipient: message.recipient, subject: message.subject, text: message.text });
        response = json({ id: next('msg'), state: 'queued' }, 202);
      } else {
        calls[product] += 1;
        response = await records(product, request, url.pathname.split('/').filter(Boolean).slice(3));
      }
      if (key && request.method !== 'GET') replies.set(`${product}:${key}`, response.clone());
      return response;
    },
  };

  const env: Env = {
    MDRN_PRODUCTS: binding,
    MDRN_PROJECT_ID: 'prj_test',
    MDRN_ENVIRONMENT: 'sandbox',
    MDRN_SQLITE_URL: `${ORIGIN}/_mdrn/v1/sqlite`,
    MDRN_SQLITE_TOKEN: TOKENS.SQLITE,
    ...(postgresMode === 'off' ? {} : { MDRN_POSTGRES_URL: `${ORIGIN}/_mdrn/v1/postgres`, MDRN_POSTGRES_TOKEN: TOKENS.POSTGRES }),
    MDRN_MAIL_URL: `${ORIGIN}/v1/mail`,
    MDRN_MAIL_TOKEN: TOKENS.MAIL,
    ...options.settings,
  };

  return {
    env,
    databases,
    sent,
    calls,
    /** Signs a user in; answers the caller as MDRN would deliver their requests. */
    user(id: string, email?: string): Caller {
      const token = `idt_${id}_${++sequence}`;
      accounts.set(token, { id, email });
      return { web: { id, token } };
    },
  };
}

export type Fake = ReturnType<typeof fakeMdrn>;

export interface Caller {
  web?: { id: string; token: string };
  origin?: string | null;
}

/** Sends a request to the app the way MDRN would deliver it. */
export async function call(fake: Fake, method: string, path: string, body?: unknown, who: Caller = {}) {
  const headers = new Headers();
  if (who.web) {
    headers.set('x-mdrn-user-id', who.web.id);
    headers.set('x-mdrn-identity-token', who.web.token);
  }
  const origin = who.origin === undefined ? (who.web && method !== 'GET' ? ORIGIN : null) : who.origin;
  if (origin) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), fake.env);
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, body: parsed };
}

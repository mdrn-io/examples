// A small client for the MDRN products this starter uses: records in SQLite or Postgres, Mail,
// and the signed-in user's profile. Each call goes through the MDRN_PRODUCTS binding with the
// product's own token, which MDRN injected into this release. The tokens never leave this Worker.
//
// Every write carries an Idempotency-Key: MDRN requires one, and repeating a call with the same
// key returns the first result instead of doing the work twice.
import type { Env } from './env.ts';

/** A product call that did not succeed. `code` is MDRN's error code, such as CONFLICT. The
 * message is MDRN's and is for your logs; answer clients in your own words (see src/errors.ts). */
export class ProductError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProductError';
    this.status = status;
    this.code = code;
  }
}

/** A product this release has no binding for: it is off for the project. */
export class ProductUnavailable extends Error {
  constructor(product: string) {
    super(`${product} is off for this project`);
    this.name = 'ProductUnavailable';
  }
}

export type Product = 'SQLITE' | 'POSTGRES' | 'MAIL';
const productNames: Record<Product, string> = { SQLITE: 'SQLite', POSTGRES: 'Postgres', MAIL: 'Mail' };

/** Whether this release has the binding, URL and token for a product. */
export const hasProduct = (env: Env, product: Product) => Boolean(env.MDRN_PRODUCTS && env[`MDRN_${product}_URL`] && env[`MDRN_${product}_TOKEN`]);

interface CallOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: number;
}

async function call<T>(env: Env, product: Product, path: string, options: CallOptions = {}): Promise<T> {
  const base = env[`MDRN_${product}_URL`];
  const token = env[`MDRN_${product}_TOKEN`];
  if (!env.MDRN_PRODUCTS || !base || !token) throw new ProductUnavailable(productNames[product]);
  // The token is a bearer credential: it only goes to an https URL (plain http only to this
  // machine, for local development). MDRN always injects https URLs.
  const url = new URL(base + path);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`MDRN_${product}_URL must be an https URL`);
  }
  const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${token}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set('If-Match', String(options.ifMatch));
  const response = await env.MDRN_PRODUCTS.fetch(
    new Request(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // A redirect is never followed, so the token cannot be carried to another origin.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (response.status >= 300 && response.status < 400) {
    throw new ProductError(response.status, 'UNEXPECTED_REDIRECT', `MDRN answered with a redirect (HTTP ${response.status}), which is not followed`);
  }
  const payload: any = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
    throw new ProductError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
      typeof error?.message === 'string' ? error.message : `MDRN request failed with HTTP ${response.status}`,
    );
  }
  return payload as T;
}

/** A fresh key for a write that should happen once. */
export const newKey = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------------------------
// Records
//
// SQLite and Postgres take the same record calls; only the address and token differ. A record is
// a JSON object (up to 64 KiB) in a named collection, with an id MDRN assigns and a version that
// grows by one on every change. Updates and deletes name the version they expect (If-Match); if
// the record changed since, MDRN answers 409 CONFLICT and nothing is written.

export interface StoredRecord<T> {
  id: string;
  collection: string;
  version: number;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface RecordPage<T> {
  items: StoredRecord<T>[];
  nextCursor: string | null;
}

const recordsPath = (collection: string, id?: string) =>
  `/collections/${encodeURIComponent(collection)}/records${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;

/** The record calls against one database. src/store.ts decides which. */
export function records(env: Env, database: 'SQLITE' | 'POSTGRES') {
  return {
    create<T>(collection: string, data: T, idempotencyKey = newKey()) {
      return call<StoredRecord<T>>(env, database, recordsPath(collection), { method: 'POST', body: { data }, idempotencyKey });
    },
    /** The record, or null when there is none with that id. */
    async get<T>(collection: string, id: string): Promise<StoredRecord<T> | null> {
      try {
        return await call<StoredRecord<T>>(env, database, recordsPath(collection, id));
      } catch (error) {
        if (error instanceof ProductError && error.status === 404) return null;
        throw error;
      }
    },
    list<T>(collection: string, options: { limit?: number; cursor?: string } = {}) {
      const query = new URLSearchParams();
      if (options.limit) query.set('limit', String(options.limit));
      if (options.cursor) query.set('cursor', options.cursor);
      return call<RecordPage<T>>(env, database, recordsPath(collection) + (query.size ? `?${query}` : ''));
    },
    /** Merges `data` into the record's top-level fields. */
    update<T>(collection: string, id: string, data: Partial<T>, version: number, idempotencyKey = newKey()) {
      return call<StoredRecord<T>>(env, database, recordsPath(collection, id), { method: 'PATCH', body: { data }, idempotencyKey, ifMatch: version });
    },
    remove(collection: string, id: string, version: number, idempotencyKey = newKey()) {
      return call<{ deleted: true }>(env, database, recordsPath(collection, id), { method: 'DELETE', idempotencyKey, ifMatch: version });
    },
  };
}

export type Records = ReturnType<typeof records>;

// ---------------------------------------------------------------------------------------------
// Mail

export const mail = {
  send(env: Env, message: { recipient: string; subject: string; text: string }, idempotencyKey = newKey()) {
    return call<{ id: string }>(env, 'MAIL', '/messages', { method: 'POST', body: { html: null, ...message }, idempotencyKey });
  },
};

// ---------------------------------------------------------------------------------------------
// The signed-in user's profile

/** The user's email address, as MDRN's sign-in knows it, or null when it has none (a Google
 * account need not share one). Asked of /v1/auth/me with the session's identity token: the
 * address always comes from MDRN, never from the client. */
export async function identityEmail(env: Env, requestUrl: string, identityToken: string): Promise<string | null> {
  if (!env.MDRN_PRODUCTS) return null;
  const response = await env.MDRN_PRODUCTS.fetch(
    new Request(new URL('/v1/auth/me', requestUrl), {
      headers: { Authorization: `Bearer ${identityToken}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    }),
  );
  if (!response.ok) return null;
  const me: any = await response.json().catch(() => null);
  return typeof me?.email === 'string' && me.email.includes('@') ? me.email.toLowerCase() : null;
}

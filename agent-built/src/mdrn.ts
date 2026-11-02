// A small client for MDRN SQLite records. Each call goes through the MDRN_PRODUCTS binding with
// the SQLite token MDRN injected into this release; the token never leaves this Worker.
//
// A record is a JSON object in a named collection, with an id MDRN assigns and a version that
// grows by one on every change. Every write carries an Idempotency-Key (MDRN requires one, and a
// repeat with the same key returns the first result). Updates and deletes name the version they
// expect (If-Match); if the record changed since, MDRN answers 409 CONFLICT and writes nothing.
import type { Env } from './env.ts';

/** A call that did not succeed. `code` is MDRN's error code, such as CONFLICT. The message is
 * MDRN's and is for your logs; answer clients in your own words (see src/errors.ts). */
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

/** SQLite is off for the project: this release has no binding for it. */
export class ProductUnavailable extends Error {
  constructor() {
    super('SQLite is off for this project');
    this.name = 'ProductUnavailable';
  }
}

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

interface CallOptions {
  method?: string;
  body?: unknown;
  ifMatch?: number;
}

// The token is a bearer credential: it only goes to an https URL (plain http only to this
// machine, for local development). MDRN always injects https URLs.
function secureBase(base: string) {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('MDRN_SQLITE_URL is not a URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('MDRN_SQLITE_URL must be an https URL');
}

async function call<T>(env: Env, path: string, options: CallOptions = {}): Promise<T> {
  const base = env.MDRN_SQLITE_URL;
  const token = env.MDRN_SQLITE_TOKEN;
  if (!env.MDRN_PRODUCTS || !base || !token) throw new ProductUnavailable();
  secureBase(base);
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${token}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('Idempotency-Key', crypto.randomUUID());
  if (options.ifMatch !== undefined) headers.set('If-Match', String(options.ifMatch));
  const response = await env.MDRN_PRODUCTS.fetch(
    new Request(base + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }),
  );
  // A redirect is never followed, so the token cannot be carried to another origin.
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

const recordsPath = (collection: string, id?: string) =>
  `/collections/${encodeURIComponent(collection)}/records${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;

export const sqlite = {
  create<T>(env: Env, collection: string, data: T) {
    return call<StoredRecord<T>>(env, recordsPath(collection), { method: 'POST', body: { data } });
  },
  /** The record, or null when there is none with that id. */
  async get<T>(env: Env, collection: string, id: string): Promise<StoredRecord<T> | null> {
    try {
      return await call<StoredRecord<T>>(env, recordsPath(collection, id));
    } catch (error) {
      if (error instanceof ProductError && error.status === 404) return null;
      throw error;
    }
  },
  list<T>(env: Env, collection: string, options: { limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (options.limit) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    return call<RecordPage<T>>(env, recordsPath(collection) + (query.size ? `?${query}` : ''));
  },
  /** Merges `data` into the record's fields. */
  update<T>(env: Env, collection: string, id: string, data: Partial<T>, version: number) {
    return call<StoredRecord<T>>(env, recordsPath(collection, id), { method: 'PATCH', body: { data }, ifMatch: version });
  },
  remove(env: Env, collection: string, id: string, version: number) {
    return call<{ deleted: true }>(env, recordsPath(collection, id), { method: 'DELETE', ifMatch: version });
  },
};

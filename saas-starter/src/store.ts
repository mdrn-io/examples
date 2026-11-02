// Which database the app keeps its data in: Postgres when the project has it, SQLite otherwise.
//
// Both take the same record calls (src/mdrn.ts `records`), so the rest of the app never knows
// which one it talks to. The choice is made once per Worker instance, from what MDRN provides:
//
//   1. DATA_STORE=sqlite or DATA_STORE=postgres, when you set it, decides.
//   2. SQLite already holds teams: keep using it. A workspace that goes live gets Postgres, and
//      switching then would leave every team made in build mode behind in SQLite.
//   3. Postgres is on and answers: use it. In build mode it answers 402 (build mode is SQLite
//      only) and when it is off the release has no binding for it; either way, SQLite.
//
// Checking costs one SQLite read and one Postgres call per Worker instance, not per request.
// The first Postgres call is also what makes the database: until it is ready MDRN answers
// 503 DATABASE_STARTING, which still means Postgres is there.
import type { Env } from './env.ts';
import { hasProduct, ProductError, ProductUnavailable, records, type Records } from './mdrn.ts';

export type StoreKind = 'sqlite' | 'postgres';

export interface Store extends Records {
  kind: StoreKind;
}

/** The collection every team lives in; its being empty is what rule 2 reads. */
export const TEAMS = 'teams';

const open = (env: Env, kind: StoreKind): Store => ({ kind, ...records(env, kind === 'postgres' ? 'POSTGRES' : 'SQLITE') });

async function choose(env: Env): Promise<StoreKind> {
  const forced = env.DATA_STORE?.trim().toLowerCase();
  if (forced === 'sqlite' || forced === 'postgres') return forced;
  const sqlite = hasProduct(env, 'SQLITE');
  if (!hasProduct(env, 'POSTGRES')) {
    if (!sqlite) throw new ProductUnavailable('SQLite and Postgres');
    return 'sqlite';
  }
  if (!sqlite) return 'postgres';
  if ((await open(env, 'sqlite').list(TEAMS, { limit: 1 })).items.length > 0) return 'sqlite';
  try {
    await open(env, 'postgres').list(TEAMS, { limit: 1 });
    return 'postgres';
  } catch (error) {
    if (!(error instanceof ProductError)) throw error;
    if (error.code === 'DATABASE_STARTING') return 'postgres';
    // Build mode (402), Postgres off (403) or not allowed: SQLite. Anything else is MDRN being
    // unavailable for a moment, so nothing is decided and the next request asks again.
    if ([402, 403].includes(error.status)) return 'sqlite';
    throw error;
  }
}

// One choice per Worker instance (per env object), made by the first request that needs it.
const chosen = new WeakMap<Env, Promise<StoreKind>>();

export async function store(env: Env): Promise<Store> {
  let kind = chosen.get(env);
  if (!kind) {
    kind = choose(env);
    chosen.set(env, kind);
    // A failed check is not remembered.
    kind.catch(() => chosen.delete(env));
  }
  return open(env, await kind);
}

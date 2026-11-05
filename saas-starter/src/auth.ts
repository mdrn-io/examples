// Who is calling.
//
// Turn on sign-in for the service's origin (in the console, or with
// `mdrn identity enable --origin https://<your app>`). MDRN then serves the hosted /login page
// and, on every request from a signed-in browser, adds two headers:
//   x-mdrn-user-id         the user's id
//   x-mdrn-identity-token  a short-lived token for that session
// MDRN first deletes every x-mdrn-* header the caller sent, so a client cannot forge them, and
// this Worker is reachable only through MDRN. That is why the headers can be trusted here.
// MDRN attaches the MDRN_PRODUCTS binding to every release it deploys; without it (a local
// `wrangler dev`, a copy deployed anywhere else) the headers are ignored, so such a copy has no
// sign-in rather than one anybody can forge.
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, SignedInUser } from './env.ts';
import { fail } from './errors.ts';

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function signedInUser(c: Context<AppEnv>): SignedInUser | null {
  if (!c.env?.MDRN_PRODUCTS) return null;
  const id = c.req.header('x-mdrn-user-id');
  const identityToken = c.req.header('x-mdrn-identity-token');
  if (!id || !USER_ID.test(id) || !identityToken) return null;
  return { id, identityToken };
}

/** A cookie-signed-in write must come from this app's own pages. Every app on *.mdrn.build
 * shares that parent domain, and a browser that does not yet treat it as a public suffix sees
 * them all as one "site", so SameSite cookies alone could let another app's page post here with
 * your user's cookie; the Origin header tells them apart in every browser. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  if (origin) return origin === new URL(c.req.url).origin;
  return c.req.header('Sec-Fetch-Site') === 'same-origin';
}

/** Requires a signed-in user and puts them in c.get('user'). */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = signedInUser(c);
  if (!user) return fail(c, 401, 'unauthenticated', 'Sign in to continue.');
  if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) return fail(c, 403, 'forbidden', 'This request must come from the app itself.');
  c.set('user', user);
  await next();
});

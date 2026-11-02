// The app: one Hono app, deployed by MDRN as a Worker. Every request reaches it through MDRN,
// which has already served sign-in (/login and MDRN's own /_mdrn paths never reach this code) and
// added the signed-in user's headers (see src/auth.ts).
//
//   GET    /, /app.js, /app.css                    the frontend (src/ui.ts)
//   GET    /health                                 readiness, no sign-in
//   GET    /api/me                                 who is signed in, and which database is in use
//   *      /api/teams[/:teamId[/settings]]         teams and their settings (src/routes/teams.ts)
//   *      /api/teams/:teamId/members[/:memberId]  members, roles, leaving
//   *      /api/teams/:teamId/invites[/:inviteId]  invitations (src/routes/invites.ts)
//   POST   /api/invites/accept                     accept an invitation
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { requireUser } from './auth.ts';
import type { AppEnv } from './env.ts';
import { fail, handleError } from './errors.ts';
import { identityEmail } from './mdrn.ts';
import { rateLimit } from './rate-limit.ts';
import { invites } from './routes/invites.ts';
import { teams } from './routes/teams.ts';
import { store } from './store.ts';
import { CSP, css, html, js } from './ui.ts';

const app = new Hono<AppEnv>();

// Hardening headers on every answer: nosniff, no framing by other sites, no referrer. The
// frontend's three answers add their own Content-Security-Policy.
app.use('*', secureHeaders({ strictTransportSecurity: 'max-age=15552000' }));
app.onError(handleError);
app.notFound(c => fail(c, 404, 'not_found', 'Not found.'));

// Readiness: MDRN calls it before a release takes traffic (mdrn.jsonc: readinessPath). It calls no
// product, so it stays cheap and does not fail when a database is briefly unavailable.
app.get('/health', c => c.json({ ok: true }));

// The frontend is the same for everyone and holds no data: it asks /api for that.
const page = (body: string, type: string) => (c: Context) => {
  c.header('Content-Security-Policy', CSP);
  c.header('Cache-Control', 'no-cache');
  return c.body(body, 200, { 'Content-Type': type });
};
app.get('/', page(html, 'text/html; charset=utf-8'));
app.get('/app.js', page(js, 'text/javascript; charset=utf-8'));
app.get('/app.css', page(css, 'text/css; charset=utf-8'));

// Everything under /api needs a signed-in user, takes small JSON bodies, and is never cached.
app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: c => fail(c, 413, 'too_large', 'The request body is too large.') }));
app.use('/api/*', requireUser, rateLimit('api', 120, 60_000));
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

app.get('/api/me', async c => {
  const user = c.get('user');
  const [email, db] = await Promise.all([identityEmail(c.env, c.req.url, user.identityToken), store(c.env)]);
  return c.json({ id: user.id, email, store: db.kind });
});
app.route('/api/teams', teams);
app.route('/api', invites);

export default app;

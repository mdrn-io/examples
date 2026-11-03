// The app: one Hono app, deployed by MDRN as a Worker. Every request reaches it through MDRN's
// Proxy, which has already served sign-in (/login and MDRN's own paths never reach this code) and
// added the signed-in user's headers (see src/auth.ts).
//
//   GET    /                  the page; /app.js and /app.css are its script and style
//   GET    /health            readiness, no sign-in
//   GET    /s/:code           anyone: redirect to the link, counting the click
//   GET    /api/links         the user's own links, with click counts
//   POST   /api/links         make a short link: { url, code? }
//   DELETE /api/links/:id     delete one of the user's links
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { requireUser } from './auth.ts';
import type { AppEnv } from './env.ts';
import { fail, handleError } from './errors.ts';
import { follow, links } from './links.ts';
import { css, html, js } from './page.ts';
import { rateLimit } from './rate-limit.ts';

const app = new Hono<AppEnv>();

// Hardening headers on every answer, and a Content-Security-Policy that lets the page load only
// its own script and style: no inline script, nothing from another origin.
app.use(
  '*',
  secureHeaders({
    strictTransportSecurity: 'max-age=15552000',
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  }),
);
app.onError(handleError);
app.notFound(c => fail(c, 404, 'not_found', 'Not found.'));

// Readiness: MDRN calls it before a release takes traffic (mdrn.jsonc: readinessPath). It reads
// nothing, so it stays cheap and does not fail when the database is briefly unavailable.
app.get('/health', c => c.json({ ok: true }));

const asset = (body: string, type: string) => (c: Context) => {
  c.header('Content-Type', type);
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(body);
};
app.get('/', asset(html, 'text/html; charset=utf-8'));
app.get('/app.js', asset(js, 'text/javascript; charset=utf-8'));
app.get('/app.css', asset(css, 'text/css; charset=utf-8'));

app.get('/s/:code', rateLimit('follow', 120, 60_000, 'address'), follow);

app.use('/api/*', bodyLimit({ maxSize: 8 * 1024, onError: c => fail(c, 413, 'too_large', 'The request body is too large.') }));
app.use('/api/*', requireUser(), rateLimit('api', 120, 60_000, 'user'));
app.use('/api/*', async (c, next) => {
  await next();
  // Answers are per user: never cached by a browser or anything between.
  c.header('Cache-Control', 'private, no-store');
});
app.route('/api/links', links);

export default app;

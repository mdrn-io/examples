# Built by an AI agent: a link shortener on MDRN

A small link shortener that an AI agent wrote from one prompt, ready to deploy on
[MDRN](https://mdrn.io) without edits. The prompt is in [PROMPT.md](PROMPT.md); what the agent
did, and what a person still has to check, is in [BUILT-BY-AN-AGENT.md](BUILT-BY-AN-AGENT.md).

It is a TypeScript [Hono](https://hono.dev) app that runs as a Worker, and it shows:

- **Sign-in** with MDRN's hosted sign-in page, and a CSRF check on every write.
- **Short links**: a signed-in user makes a short link to an http or https URL, with a code they
  choose (3 to 32 of `a-z`, `0-9`, `-`) or a random one of 7 characters, lists their own links
  with click counts, and deletes them. Codes that read as the app's own paths (`api`, `health`,
  `s`…) and links back to the app itself are refused.
- **Redirects**: anyone follows `/s/<code>` and gets a `302`, never cached. The click is counted
  with one optimistic update; when two clicks meet or the count fails, that one count is lost,
  never the redirect.
- **Data in MDRN SQLite records only**, so it runs in build mode. Nothing else to set up.
- A tiny page at `/`, served by the Worker, with no inline script.

MIT licensed: copy it, change it, ship it.

```
mdrn.jsonc         how MDRN builds it: entry, tests, readiness path
src/index.ts       the routes, and the middleware in front of them
src/links.ts       short links: how they are stored, made, listed, deleted and followed
src/page.ts        the page, its script and its style
src/auth.ts        the signed-in user, from MDRN's headers
src/mdrn.ts        a small client for SQLite records
test/              node --test suites, against an in-memory stand-in for MDRN
```

## Deploy it to MDRN

1. Put this folder in a GitHub repository and connect it to a service in the MDRN console, or
   upload the source (`npx @mdrnio/cli deploy` in this folder). MDRN runs `npm ci`, then
   `npm test` (from `mdrn.jsonc`), bundles `src/index.ts` and waits for `/health` before the
   release takes traffic.
2. Keep **SQLite** on for the project (a new project has it on). MDRN injects
   `MDRN_SQLITE_URL` and `MDRN_SQLITE_TOKEN` into every release; with SQLite off the API answers
   503 in plain words.
3. Turn on **sign-in** for the service's origin, in the console or with
   `mdrn identity enable --origin https://<your app>`. MDRN then serves the hosted `/login` page
   on your app's hostname. Keep the sign-in policy at **mixed** (the default): `/` and `/s/*`
   must stay open to people who are not signed in, and the app checks sign-in itself on `/api/*`.

## How it stores links

MDRN assigns record ids, so a code cannot be a record id. Each code gets a collection of its own,
`link_<code>`, holding the link as its one record: `{ ownerId, url, clicks }`. Following a link
lists that collection and takes the record created first. Two people claiming one code at the
same moment may both write there; whoever's record came second removes it and is told the code
is taken.

Each user also has an index collection, `links_u…` (named from a hash of their user id), with one
small record per link they made, so listing their links reads only theirs. Both records carry
the owner, and every route checks it before it answers.

## How the signed-in user arrives

MDRN's Proxy sits in front of every request. When sign-in is on and the browser has a session,
Proxy adds `x-mdrn-user-id` and `x-mdrn-identity-token`, after deleting any `x-mdrn-*` header the
caller sent, so they cannot be forged. `src/auth.ts` trusts them only when the Worker runs on MDRN
(the `MDRN_PRODUCTS` binding is there), and every write must come from the app's own origin.
Run anywhere else, the app has no sign-in rather than one anybody can forge. Never expose a
local server.

## Billing

Every call runs your Worker, so each counts as **Requests** and **CPU time** on your MDRN bill.
Each redirect is one request plus one SQLite read (the link) and one SQLite write (the click
count); a malformed code costs no read. Making a link costs two reads and two writes (more only when a
random code collides); listing your links costs one read for the page plus one per link shown
(up to 50); deleting one costs two reads and two writes (more only when a click lands at the
same moment). The page, its script and its style are requests with
no reads. The in-memory rate limiter costs nothing and is advisory: each Worker instance keeps its
own counts. See https://mdrn.io/docs/billing for prices.

## Develop

```sh
npm install
npm test            # node --test against an in-memory stand-in for MDRN
npm run typecheck
```

Requires Node 22.18 or later, which runs TypeScript directly; `.node-version` names the exact
version MDRN builds with, and CI uses it. The tests call the app through `app.fetch` exactly as
MDRN delivers requests; deploy to a Sandbox environment to try it against the real SQLite.

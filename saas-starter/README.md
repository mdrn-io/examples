# MDRN SaaS starter

A small, readable starting point for a multi-user SaaS app, ready to deploy on
[MDRN](https://mdrn.io) without edits. It shows:

- **Sign-in** with MDRN's hosted sign-in page: the app never sees a password and keeps no
  session of its own.
- **Teams**: anyone signed in creates a team and owns it. Members have one of three roles:

  | | Owner | Admin | Member |
  | --- | --- | --- | --- |
  | See the team and its members | yes | yes | yes |
  | Change the team's settings | yes | yes | |
  | Invite people | yes | yes | when the team allows it, as members |
  | See and revoke invitations | yes | yes | |
  | Remove someone | anyone | members | |
  | Change roles, delete the team | yes | | |

- **Invitations by email** through MDRN Mail: a one-time link, accepted only by someone signed
  in with the invited address, capped per team per day.
- **Per-team settings**: name, description, time zone and whether members may invite, with
  versioned updates so two admins never overwrite each other.
- **One data layer, two databases**: Postgres when the project has it, SQLite otherwise (below).
- A tiny frontend served by the same Worker: plain HTML and JavaScript, no build step.

It is a TypeScript [Hono](https://hono.dev) app that runs as a Worker. MIT licensed: copy it,
change it, ship it.

```
mdrn.jsonc             how MDRN builds it: entry, tests, readiness path
src/index.ts           the routes, and the middleware in front of them
src/auth.ts            the signed-in user, from MDRN's headers
src/store.ts           which database: Postgres or SQLite, chosen at runtime
src/mdrn.ts            a small client for records, Mail and the user's profile
src/teams.ts           where teams, members and roles live, and who may do what
src/routes/teams.ts    teams, settings, members, roles
src/routes/invites.ts  invitations: create, mail, list, revoke, accept
src/ui.ts              the frontend: one page, its script and its stylesheet
test/                  node --test suites, against an in-memory stand-in for MDRN
```

## Deploy it to MDRN

1. Put this repository on GitHub and connect it to a service in the MDRN console (or upload the
   source, or run `npx @mdrnio/cli deploy` in this folder). MDRN runs `npm ci`, then `npm test`
   (from `mdrn.jsonc`), bundles `src/index.ts` and waits for `/health` before the release takes
   traffic.
2. Turn on **sign-in** for the service's origin, in the console or with
   `mdrn identity enable --origin https://<your app>`. MDRN then serves the hosted `/login` page
   on your app's hostname. Keep the service's sign-in policy at **mixed** (the default): the
   page itself is public, and the app checks sign-in on `/api/*`.
3. Open the app, sign in, create a team.

A new project has SQLite, Postgres and Mail on, and MDRN injects their `MDRN_*` addresses and
tokens into every release. Nothing else is required.

### In build mode

Build mode is SQLite only, so the starter keeps everything in SQLite and works as it is. Mail
in build mode goes only to your workspace's members: an invitation to anyone else is still made,
and the app shows its link for you to pass on yourself. In build mode only you can open the app,
so try invitations with your own second address once you go live.

## Postgres or SQLite

SQLite and Postgres take the same record calls on MDRN, so `src/mdrn.ts` has one `records`
client and `src/store.ts` decides which database it talks to, once per Worker instance:

1. `DATA_STORE` set to `sqlite` or `postgres` (a service variable) decides.
2. SQLite already holds teams: keep using SQLite. This is what a project that started in build
   mode sees after going live, so its teams do not disappear when Postgres arrives.
3. Postgres is on and answers: use Postgres. In build mode it answers that it comes with going
   live, and a project with it off has no Postgres address; either way, SQLite.

Checking costs one SQLite read and one Postgres call per Worker instance, never per request.
Postgres is made the first time it is used and takes a few seconds; until then the API answers
`503` with `Retry-After: 5`.

To move a build-mode project's teams to Postgres after going live, export SQLite, copy the
records over, and set `DATA_STORE=postgres`; or keep SQLite, which serves a small SaaS well.
`GET /api/me` and the page header say which database is in use.

## How the data is laid out

Each kind of thing is a collection of JSON records, the same in either database:

| Collection | One record per |
| --- | --- |
| `teams` | team: name and settings |
| `members_<teamId>` | member of that team: user id, email, role |
| `teams_<user>` | team a user belongs to, so "my teams" reads only their entries |
| `invites_<teamId>` | pending invitation: address, role, the link's hash, expiry |
| `invite_quota_<teamId>` | the team's invitation count for today |

A role lives only in the member record, and every check reads it and compares its user id with
the signed-in user's. A team you are not in answers `404`, exactly like one that does not exist.

## Invitations

`POST /api/teams/:id/invites` with `{ email, role }` makes a one-time link,
`https://<your app>/#invite=<token>`, and mails it from MDRN Mail. Only a hash of the token is
stored, and it rides in the URL's fragment, which browsers never send to a server. The invited
person opens it, signs in, and the page posts the token to `POST /api/invites/accept`; the
backend reads their address from MDRN's sign-in and accepts only the invited one. Links expire
after 7 days and work once.

The app mails addresses its users type, so each team may send at most 20 invitations a day
(`INVITE_DAILY_LIMIT`), counted in the database so the cap holds across every Worker instance,
and the mail's wording is fixed. When no email could be sent (Mail off, build mode, no verified
sender domain yet), the invitation is still made and the answer carries the link and the reason.

## Billing

Every call to the app runs your Worker, so each counts as **Requests** and **CPU time** on your
MDRN bill. What a route then does is counted on that product's own meters: record reads and
writes on SQLite, or compute and storage on Postgres, and **Emails** for invitations. Checking
membership reads the user's team list and their member record, so a team route costs a few
reads. The hosted sign-in pages are MDRN's. See https://mdrn.io/docs/billing for prices.

## Develop

```sh
npm install
npm test            # node --test against an in-memory stand-in for MDRN
npm run typecheck
```

Requires Node 22.18 or later, which runs TypeScript directly; `.node-version` names the exact
version MDRN builds with, and CI uses it. The tests exercise the routes through `app.fetch`
exactly as MDRN delivers requests, with Postgres live, in build mode, off and starting; deploy
to a Sandbox environment to try it against the real products.

The sign-in headers are trusted only when the Worker runs on MDRN, told by the `MDRN_PRODUCTS`
binding MDRN attaches to every release. A copy run anywhere else has no sign-in rather than one
anybody can forge. Never expose a local server.

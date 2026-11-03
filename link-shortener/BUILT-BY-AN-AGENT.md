# How this app was built

Written by Claude, an AI model by Anthropic, via Claude Code (model Claude Opus 5.5), on
2026-11-02. This is the agent's own log, kept short and honest.

## What the agent did

1. **Read the house style.** Read MDRN's `templates/app-backend`: its README, `package.json`,
   `tsconfig.json`, `mdrn.jsonc`, CI workflow, the source files and its in-memory test stand-in
   for MDRN. Checked which characters MDRN accepts in a collection name (letters, digits, `_`,
   `-`, up to 128) so `link_<code>` is always valid.
2. **Wrote the prompt** in [PROMPT.md](PROMPT.md), before writing any code, then followed it.
3. **Chose the storage.** MDRN assigns record ids, so a code cannot be one. One collection per
   code (`link_<code>`, one record) plus one index collection per user. Found while writing it:
   record ids do not follow creation order, so "lowest id wins" could let a later claim take a
   code over; the owner is the record created first instead, and a claim that comes second takes
   its record back.
4. **Wrote the code and the tests**: `src/` (a Hono Worker, zod validation, a small SQLite client,
   errors in the app's own words, the same Origin check and rate limiter as app-backend) and
   `test/` (an in-memory stand-in for MDRN whose record ids come from the Idempotency-Key).
5. **Ran the checks**: `npm install`, `npm ci`, `npm run typecheck` (clean) and `npm test`. The
   first run failed in the redirect tests, which used a 2-character code, below the 3-character
   minimum; the tests were wrong, not the app. After fixing them, **17 tests, 17 passed**.
6. **Ran MDRN's builder** on a clean copy of the folder, as MDRN builds a customer's repository
   (`npm ci`, the test command, the bundle): it built into one module from `src/index.ts`.

The agent **did not deploy it** in this session. Deploying is one click in the console (connect
the repository) or one command (`npx @mdrnio/cli deploy`) for whoever copies it.

## What the tests prove

- A user makes a link with their own code, lists it and deletes it; the code is free again after.
- Without a code, a random 7-character one is made.
- A code someone already has is refused.
- Of two claims racing for one code, the one created first keeps it and the other is taken back.
- A later record with a lower id does not take a code over.
- Bad links and codes (not a URL, not http/https, a user name or password, a link back to the
  app, too short, capitals, reserved, an unknown field, too long) are refused and nothing is stored.
- Another user cannot see or delete my links.
- Following a link redirects with `302`, `Cache-Control: no-store`, and counts the click.
- A click that cannot be counted still redirects.
- A link can be deleted while a click changes it at the same moment.
- An unknown or malformed code answers 404.
- The API needs a signed-in user.
- Sign-in headers are ignored when the Worker is not running on MDRN.
- A write from another origin, or with no origin, is refused.
- The page loads only its own script and style, allows no inline script, and links to sign-in;
  `/health` answers.
- The SQLite client refuses a redirect and sends its token only over https.
- With SQLite off, the API says so in its own words.

## What a person reviewed, and what is left

- Reviewed: nothing yet by a person at the time of this log. The MDRN team asked for this
  example and reviews the change before it is merged into MDRN's templates.
- Left for a person: deploy it to a Sandbox environment and try it against the real SQLite and
  sign-in (the tests use a stand-in); look at the page in a browser, which the agent did not do;
  decide whether to cap how many links one user may make, which this app does not.

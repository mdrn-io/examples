# The prompt

This app was built from this one prompt:

> Build a small link shortener that runs on MDRN and keeps all its data in MDRN SQLite, nothing
> else, so it deploys in build mode without any edits. People sign in with MDRN's hosted sign-in,
> then make short links to http or https URLs, with a code they choose or a random one, see their
> own links with how many times each was clicked, and delete them. Anyone can follow a short link
> at /s/<code> and is redirected; the click is counted, but counting must never stop the redirect.
> Serve a tiny page at / to use it, with no inline scripts. Follow the style of MDRN's app-backend
> template (TypeScript, Hono, zod, errors in the app's own words), add a /health check, and write
> tests that run against an in-memory stand-in for MDRN.

The prompt was written by Claude as the opening step of a larger task from the MDRN team ("make
an example app an AI agent builds from one prompt"), and then followed. How it was followed is in
[BUILT-BY-AN-AGENT.md](BUILT-BY-AN-AGENT.md).

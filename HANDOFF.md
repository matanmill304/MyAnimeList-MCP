# Where we are — 2026-10-18

## What exists

A remote MCP connector for MyAnimeList, built to be listable in the Claude connector
directory. Pushed to <https://github.com/matanmill304/MyAnimeList-MCP> (commit `457de18`).

Cloudflare Worker, ~1,300 lines, typechecks clean. OAuth 2.1 authorization server to Claude
(with dynamic client registration), OAuth client to MyAnimeList behind it. Stateless, KV only,
free tier.

11 tools, all annotated with `title` + `readOnlyHint`/`destructiveHint`. The two that matter:
`get_my_taste_profile` (aggregates your own scores into genre/studio/decade preferences) and
`get_mal_suggestions` (MAL's `/anime/suggestions`, which no existing MAL MCP server exposes).

## Verified working

- OAuth discovery metadata, both well-known endpoints
- Dynamic client registration
- `401` + `WWW-Authenticate` challenge on unauthenticated `/mcp`
- Consent page renders with client name, redirect host and scopes
- `POST /authorize` → 302 redirect to MyAnimeList
- MAL **accepts** our client ID and redirect URI — proven by control test:
  registered URI → `303 → login`, deliberately bogus URI → `401`

## Not yet verified

The MyAnimeList round-trip itself: login → MAL consent → `/callback/mal` → token exchange →
calling the tools against a real list. Everything up to the MAL handoff is confirmed.

## The blocker

**Port 8787 is in a bad state on this machine.** Two dev servers ended up running at once (my
error — the first one held placeholder credentials, which is what caused the failed logins and
the unnecessary password change). Force-killing them left stale listeners: `wrangler dev`
reports "Ready on 8787" but serves nothing.

Confirmed it is the port, not the code — the identical server came up first try on port 8799.

Port 8787 matters because the MAL app's redirect URI is registered as
`http://localhost:8787/callback/mal`.

## Tomorrow

1. **Free port 8787.** A reboot is the fastest certain fix. Otherwise find the owning PIDs
   (`netstat -ano | findstr 8787`) and kill them, and check Windows hasn't reserved the port
   (`netsh int ipv4 show excludedportrange protocol=tcp`).
2. **`npx wrangler dev`**, then open the `/authorize` URL and complete the MAL login. Worth
   running it in your own terminal rather than through me — the sandbox added failure modes
   that aren't real.
3. **Run every tool** against the real list: profile, taste profile, suggestions, search, and
   one write.
4. **Then deploy**: create the KV namespace, `wrangler secret put` both MAL credentials, set
   `PUBLIC_URL` to the deployed origin, and add that origin's `/callback/mal` to the MAL app's
   redirect URIs (the field takes multiple, one per line — keep localhost too).
5. **Submit** — see `SUBMISSION.md`. Two gaps to close first: a real support email in the
   README's privacy policy (an incomplete one is an instant rejection), and a reviewer test
   account with a populated list.

## Notes to self

- `.dev.vars` holds the real MAL credentials and is gitignored. `PUBLIC_URL` in it must match
  the port you run on and the redirect URI registered at MAL.
- The browser "Sign in" popup we hit was HTTP Basic auth from a `401`, not MAL's login page.
  It appears whenever the client ID is wrong — a useful signal.

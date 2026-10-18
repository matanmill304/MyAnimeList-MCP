# Deploy and publish plan

Goal: take the verified prototype to a deployed connector that anyone can add in Claude, and
get it listed in the Claude directory as a Community connector.

Current state: works end to end on localhost against a real MyAnimeList account (OAuth
brokering, token exchange, all read tools returning live data). Not deployed, not submitted.

Estimated total: **half a day**, most of it waiting on DNS and the review scan.

---

## Decisions needed from you

These block me from working unattended. Everything else I can do.

| # | Decision | Default if you don't care |
| --- | --- | --- |
| D1 | **Domain**: custom domain, or `*.workers.dev`? | `workers.dev` to start. It works and costs nothing; a listing looks better on a real domain, and switching later means re-registering the MAL redirect URI and re-submitting the URL. |
| D2 | **Reviewer test account**: a throwaway MAL account with a populated list, or your own? | Make a throwaway. Reviewers get the credentials, and the account needs ~30+ scored titles or the headline tools look broken. Populating it is ~20 minutes. |
| D3 | **Support contact** email for the listing and privacy policy. | Needed verbatim — this is a hard blocker (see B2). |
| D4 | **Catalogue mirror**: stay on Tenrai, add Jikan fallback, or official-API-only? | Add the Jikan fallback. Tenrai self-describes as beta and is a single point of failure for 6 of 11 tools. |

---

## Phase 0 — Fix before deploying

Do these first; they get harder once strangers are connected.

### 0.1 Test the token refresh path (highest priority)

`tokenExchangeCallback` in `src/index.ts` rolls the MyAnimeList token forward and persists the
rotated refresh token. **It has never executed.** If it is wrong, every user silently breaks
after a month and reconnecting is the only cure.

How: temporarily set `accessTokenTTL` to ~60s, connect, wait for Claude (or a manual
`grant_type=refresh_token` call) to refresh, then confirm the new MAL tokens were persisted and
tools still work. Also force the failure path by revoking the app at
<https://myanimelist.net/apiconfig> mid-session and confirming we throw `invalid_grant` rather
than retrying forever.

### 0.2 Read MyAnimeList's API terms

Still outstanding. The portal's **Data handling** step makes you declare the upstream is a third
party you don't control, and you will be holding other users' MAL tokens. Confirm that a hosted
multi-user client is permitted, and that we are not required to display anything specific.

### 0.3 Add a test suite

Not a directory requirement, but you are taking responsibility for other people's accounts with
write access. Minimum worth having:

- `buildTasteProfile` against fixture lists (empty list, no scores, single genre, the real shape)
- the MAL client's error mapping (401 → reconnect message, 404, 5xx)
- the consent + callback flow against a mocked MAL
- a contract test that every registered tool has a `title` and the right annotation

### 0.4 Jikan fallback (if D4 says so)

`CATALOG_BASE_URL` is already configuration. Add a second client and fail over on 5xx/timeout,
mirroring the pattern Grinv documents. Note Jikan was unreachable from this machine during
testing — verify from the deployed Worker, not from here.

### 0.5 Housekeeping

- Add a `LICENSE` file — the README claims MIT but there is no license file.
- Credit `Grinv/mal-mcp` in the repo as the README already does (MIT requires attribution).
- Design an icon for the listing (also used as the favicon).

---

## Phase 1 — Deploy to Cloudflare

```bash
cd "C:\MAL MCP"
npx wrangler kv namespace create OAUTH_KV      # paste the returned id into wrangler.jsonc
npx wrangler secret put MAL_CLIENT_ID
npx wrangler secret put MAL_CLIENT_SECRET
```

Then in `wrangler.jsonc`:

- replace `PLACEHOLDER_RUN_WRANGLER_KV_NAMESPACE_CREATE` with the real namespace id
- set `PUBLIC_URL` to the deployed origin, **no trailing slash**

```bash
npx wrangler deploy
```

**`PUBLIC_URL` must exactly match the host Claude connects to.** We already hit this locally:
calling `127.0.0.1` while the resource was declared as `localhost` produced
`Token audience does not match resource server`. The same mismatch in production breaks every
tool call with a confusing error.

Smoke test after deploy:

```bash
curl -s https://<origin>/.well-known/oauth-authorization-server
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<origin>/mcp   # expect 401 + WWW-Authenticate
```

---

## Phase 2 — Update the MyAnimeList app

At <https://myanimelist.net/apiconfig>, edit the existing app:

- **App Redirect URL** — add the production callback on its own line, keep localhost for dev:
  ```
  http://localhost:8787/callback/mal
  https://<origin>/callback/mal
  ```
- **Homepage URL** — `https://github.com/matanmill304/MyAnimeList-MCP`
- **Privacy Policy URL** — the published policy from B2 below

---

## Phase 3 — Verify in Claude

Add the deployed server as a **custom connector** in Claude (URL + `/mcp`) and run every tool
from a real conversation, including one write and one delete. The portal's *Test & launch* step
asks you to confirm you have done exactly this.

Specifically check:
- the consent screen names Claude and shows the right scopes
- declining `mcp:write` really does produce a read-only connector
- `get_my_taste_profile` completes within the handler time limit on a large list
- error text is readable when MAL is unreachable

---

## Phase 4 — Submit to the directory

Portal: <https://claude.ai/directory/manage> → *Submit new* → **MCP connector**.
Requires any paid Claude plan.

### Blockers to clear first

- **B1 — Deployed HTTPS URL.** Phase 1. A local server cannot be submitted on its own.
- **B2 — Published privacy policy at an HTTPS URL** with a real support contact. The draft is in
  `README.md` and still says `[Add your support email before submitting]`. **An incomplete
  privacy policy is an immediate rejection.** Publish via GitHub Pages or link the README anchor.
- **B3 — Reviewer test account** with a populated list and no MFA (D2).
- **B4 — Listing assets**: icon, documentation URL, support contact, URL slug (**permanent once
  published** — choose carefully).

### Already satisfied in code

- Streamable HTTP transport at `/mcp`
- OAuth 2.0 with dynamic client registration — verified live
- Every tool has a `title` and `readOnlyHint`/`destructiveHint` — verified via `tools/list`
- Tool descriptions match actual behaviour

### Portal steps and what each wants

| Step | Have ready |
| --- | --- |
| Connection | `https://<origin>/mcp` |
| Tools | Syncs automatically. Fix any flagged annotations on the server, not in the portal. |
| Listing | Name ≤100 chars, one-liner ≤200, description ≤2,000, 1–5 categories, docs URL, privacy URL, support contact, icon, slug |
| Use cases | Primary use cases; what users need beforehand (a MyAnimeList account); reads **and** writes |
| Company | Name, website, contact for review updates |
| Authentication | **OAuth with dynamic client registration** |
| Data handling | Third-party API we do not control. No health data, no sponsored content. |
| Test & launch | Test account credentials and step-by-step access instructions; confirm you ran every tool |
| Compliance | Seven acknowledgments, all required |

### Listing copy

Lead with the recommendation angle, not the API-wrapper angle. The differentiators are
`get_my_taste_profile` and `get_mal_suggestions` — not the tool count. Concretely: it knows you
have watched 119 Action titles and rate them *below* your own average, so it stops recommending
more of them.

---

## Phase 5 — After submission

Submissions are scanned automatically and list as **Community** by default; some also get human
review. Status and feedback appear in the portal. Escalation: `mcp-review@anthropic.com`.

**Community listing means a policy scan, not an audit.** Nobody downstream will catch a bug in
the refresh path for you — which is why Phase 0.1 comes first.

After publishing, watch the server health and usage metrics the listing provides, and have a
plan for the Tenrai dependency going down.

---

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Refresh path broken | Every user breaks after ~1 month, silently | Phase 0.1 — test before launch |
| `PUBLIC_URL` host mismatch | Every tool call fails with an opaque audience error | Verify immediately after deploy |
| Tenrai outage | 6 of 11 tools fail | Jikan fallback (0.4) |
| MAL rate limits | Unknown and undocumented; all users share one client ID | Add per-user throttling; watch metrics |
| MAL terms disallow hosted multi-user clients | Project is not viable as a connector | Phase 0.2 — read them first |
| Token storage compromise | Write access to users' MAL accounts | Already encrypted at rest, key unwrapped only by the bearer token. Document a revocation path. |

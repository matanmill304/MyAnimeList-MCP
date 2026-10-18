# MyAnimeList connector

A **remote** MCP server that connects Claude to a MyAnimeList account: your list, your scores,
your progress, and a genuine answer to "what should I watch next?"

Every existing MyAnimeList MCP server is a local stdio server that each user installs and
registers their own API app for. That design cannot be listed in the Claude connector
directory, which accepts only remote HTTPS servers. This one is built to be listed: it runs as a
single Cloudflare Worker, speaks OAuth 2.1 with dynamic client registration to Claude, and
brokers MyAnimeList's own OAuth behind it.

## What it does

**Recommendation-first, not an endpoint dump.** The point is to answer "what should I watch
next?", so the tools are shaped around that rather than mirroring the API one call per endpoint.

| Tool | What it's for |
| --- | --- |
| `get_my_taste_profile` | Aggregates your list into genres, studios, decades and formats you rate highest — plus what you watch a lot of but score *below* your own average. One call instead of hundreds. |
| `get_mal_suggestions` | MyAnimeList's own personalized picks (`/anime/suggestions`). No other MAL MCP server exposes this. |
| `get_my_list`, `get_my_profile` | Your list and stats. List reads request genres, season, format and score up front, so entries are actually reasonable about. |
| `search_titles` | Catalogue search with real filters: genre, format, status, score range, dates, sort. |
| `get_title_details`, `get_similar_titles`, `get_seasonal_anime`, `get_top_titles` | Discovery. |
| `update_my_list_entry` | Add a title, or change status, score, progress, tags, comments. |
| `remove_from_my_list` | Delete an entry. Marked `destructiveHint`. |

Writes require the `mcp:write` scope; decline it at the consent screen and the connector is
read-only.

## Architecture

```
Claude  ──OAuth 2.1 + DCR──▶  this Worker  ──OAuth 2.0 (PKCE "plain")──▶  MyAnimeList
                                  │
                                  └──▶ catalogue mirror (no credentials, read-only)
```

MyAnimeList supports neither dynamic client registration nor a PKCE method other than `plain`,
so it can never face Claude directly. This Worker is therefore an authorization server to Claude
and an OAuth *client* to MyAnimeList. The consent page in the middle is not decoration: without
per-client consent, any MCP client that discovers this server could silently borrow our MAL app
(the "confused deputy" problem).

Catalogue reads go to a MyAnimeList mirror rather than the official API because official search
takes `q` and nothing else — no genre, year, studio, status or score filter exists anywhere in
the official v2 surface, which makes "an upbeat 12-episode comedy from the last two years"
unanswerable. `CATALOG_BASE_URL` is configuration, so the mirror can be swapped.

**Stateless.** No Durable Objects and no sessions: each request builds a server, answers one
JSON-RPC message, and goes away. The whole thing runs inside Cloudflare's free tier.

## Setup

**1. Register a MyAnimeList app** at <https://myanimelist.net/apiconfig>:

- **App Type:** `web` (a confidential client, which is what a hosted server is)
- **Redirect URI:** `https://your-worker-url/callback/mal` — and `http://localhost:8787/callback/mal` for local work

**2. Configure and deploy:**

```bash
npm install
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npx wrangler secret put MAL_CLIENT_ID
npx wrangler secret put MAL_CLIENT_SECRET
npx wrangler deploy
```

Set `PUBLIC_URL` in `wrangler.jsonc` to the deployed origin. It must match the redirect URI
registered with MyAnimeList, or sign-in fails.

**3. Run locally:**

```bash
cp .dev.vars.example .dev.vars   # then fill in your MAL credentials
npx wrangler dev
```

**4. Add it to Claude** as a custom connector, using your Worker's URL plus `/mcp`.

## Privacy Policy

**What is collected.** When you connect this server, it stores a MyAnimeList access token and
refresh token issued for your account, your MyAnimeList numeric user ID, and your MyAnimeList
username. It stores nothing else: no list contents, no history, no conversation data, no
analytics about what you asked for.

**How it is stored.** Tokens are held in Cloudflare Workers KV, encrypted at rest with a key
derived from your own bearer token. The operator of this server cannot read them from storage.

**How it is used.** Tokens are used only to call the MyAnimeList API on your behalf, in direct
response to a request you make through Claude. They are never used for background processing.

**Third-party sharing.** Nothing is shared or sold. Your requests reach two upstreams: the
MyAnimeList API (<https://myanimelist.net/about/privacy_policy>), which receives your token and
the request you asked for; and a MyAnimeList catalogue mirror for anonymous public search and
detail lookups, which receives the search terms and title IDs but no token, no account
identifier and nothing identifying you.

**Retention.** Tokens live until you disconnect the connector or revoke access at
<https://myanimelist.net/apiconfig>, at which point the grant and its stored tokens are deleted.
Unused grants expire automatically.

**Contact.** _[Add your support email before submitting — the directory requires one.]_

## Status

Working and verified end to end except the MyAnimeList round-trip itself, which needs real MAL
app credentials: OAuth discovery, dynamic client registration, the 401 challenge, the consent
page and the MAL redirect all behave correctly against a local Worker.

## Credits

Informed by [`Grinv/mal-mcp`](https://github.com/Grinv/mal-mcp) (MIT), whose documented,
live-verified notes on MyAnimeList API behaviour saved a lot of rediscovery. The auth and
transport layers here are a different design, since that server is local stdio and this one is
remote.

## License

MIT

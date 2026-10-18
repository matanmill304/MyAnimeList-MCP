# Claude directory submission checklist

Submit at **<https://claude.ai/directory/manage>** → *Submit new* → **MCP connector**.
Requirements below are from <https://claude.com/docs/connectors/building/submission>.

## Eligibility

- [x] **Remote server over HTTPS.** A local server cannot be submitted on its own — it would
      have to be bundled in a plugin instead. MCPB bundles are no longer accepted at all.
- [ ] **Any paid Claude plan.** No Team/Enterprise requirement, despite what several blog posts
      claim.

## Done in code

- [x] **Streamable HTTP transport** at `/mcp`.
- [x] **OAuth 2.0 with dynamic client registration** — verified: `/oauth/register` issues a
      client, `/authorize` renders consent, `/.well-known/oauth-authorization-server` and
      `/.well-known/oauth-protected-resource/mcp` both serve correct metadata, and an
      unauthenticated `POST /mcp` returns `401` with a `WWW-Authenticate` challenge.
- [x] **Every tool has a `title`** and a `readOnlyHint` or `destructiveHint`. The portal flags
      any that don't. `remove_from_my_list` is the only `destructiveHint: true`.
- [x] **Tool descriptions match behaviour** — including the honest note that MyAnimeList reports
      a successful delete whether or not the entry existed.

## Before submitting

- [ ] **Deploy** and confirm the MyAnimeList round-trip works end to end against the real API.
- [ ] **Test in Claude as a custom connector** and call every tool from a conversation. The
      portal's *Test & launch* step asks you to confirm you've done this.
- [ ] **Privacy policy at an HTTPS URL.** Drafted in `README.md` — publish it (GitHub Pages is
      fine) and **fill in the support contact**. Missing or incomplete privacy policies are an
      immediate rejection.
- [ ] **Documentation URL**, support contact, icon, and a URL slug (permanent once published).
- [ ] **A reviewer test account**: a MyAnimeList account with a *fully populated* list, no MFA.
      An empty list makes `get_my_taste_profile` and `get_mal_suggestions` return nothing, which
      reads as broken.
- [ ] **Read MyAnimeList's API terms** before the Data handling step, which asks you to declare
      that the upstream API is a third party's that you don't control. It is.

## Listing copy

- Name ≤ 100 chars, one-liner ≤ 200 chars, description ≤ 2,000 chars, 1–5 categories.
- Lead with the recommendation angle, not the API wrapper angle: the differentiator is
  `get_my_taste_profile` + `get_mal_suggestions`, not "54 tools".

## After submitting

Submissions are scanned automatically and list as a **Community** connector by default; some
also get a human review. Status and feedback appear in the portal. Escalations:
`mcp-review@anthropic.com`.

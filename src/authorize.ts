/**
 * The /authorize page, and the MyAnimeList sign-in behind it.
 *
 * Claude is an OAuth client of this Worker; this Worker is an OAuth client of
 * MyAnimeList. The consent page in the middle is what stops any MCP client
 * that discovers this server from silently borrowing our MAL app (the
 * "confused deputy" problem). Consent first, MAL redirect second.
 */
import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { HandlerEnv, Props } from "./env.js";
import { SCOPES } from "./env.js";
import {
  createCodeVerifier,
  exchangeCode,
  fetchMalIdentity,
  malAuthorizeUrl,
  malCallbackPath,
  MalAuthError,
} from "./mal-oauth.js";

const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

const SCOPE_LABELS: Record<string, string> = {
  [SCOPES.read]: "Read your MyAnimeList profile, anime list and manga list",
  [SCOPES.write]: "Add titles, and change your status, score and episode progress",
  [SCOPES.offline]: "Stay connected without asking you to sign in again",
};

function page(body: string, title: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --bg: #fbfbfd; --muted: #5c6370; --line: #dfe1e6; --accent: #2e51a2; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e9eaee; --bg: #15171c; --muted: #9aa1ae; --line: #2c3039; --accent: #7f9bdd; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg);
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 30rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  code { font-size: .9em; }
  .muted { color: var(--muted); font-size: .9rem; }
  .warn { border-left: 3px solid #c2410c; padding: .6rem .8rem;
          background: color-mix(in srgb, #c2410c 12%, transparent); }
  ul.scopes { list-style: none; padding: 0; margin: 0 0 1.5rem; border-top: 1px solid var(--line); }
  ul.scopes li { padding: .7rem .2rem; border-bottom: 1px solid var(--line); display: flex; gap: .65rem; }
  .actions { display: flex; gap: .6rem; flex-wrap: wrap; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: 7px; border: 1px solid var(--line);
           background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
</style>
<main>${body}</main>`;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName || "An MCP client");
  const provenance = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : `<span class="muted">This app registered itself, so its name is not verified.</span>`;

  const scopes = details.scope
    .map((scope) => {
      const id = "s-" + escape(scope);
      const label = SCOPE_LABELS[scope] ?? scope;
      return `<li><input type="checkbox" name="scope" id="${id}" value="${escape(scope)}" checked>
        <label for="${id}">${escape(label)}</label></li>`;
    })
    .join("");

  const loopbackWarning = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app running <strong>on your own computer</strong>.
       Only continue if you just started signing in from it.</p>`
    : "";

  return page(
    `<h1>Allow ${name} to use your MyAnimeList account?</h1>
     <p>${provenance} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
     ${loopbackWarning}
     <p>Next you will sign in at myanimelist.net. This connector never sees your MyAnimeList password.</p>
     <form method="post">
       <input type="hidden" name="handle" value="${escape(handle)}">
       <ul class="scopes">${scopes}</ul>
       <div class="actions">
         <button class="primary" name="decision" value="approve" type="submit">Continue to MyAnimeList</button>
         <button name="decision" value="deny" type="submit">Cancel</button>
       </div>
     </form>`,
    "Authorize " + (details.clientName || "MCP client"),
  );
}

function errorPage(message: string, status = 400): Response {
  return new Response(
    page(
      `<h1>Something went wrong</h1><p>${escape(message)}</p>
       <p class="muted">Close this window and start the connection again from your MCP client.</p>`,
      "Error",
    ),
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function handleAuthorize(req: Request, env: HandlerEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  if (req.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(req);
    // describeConsent first: a failed client lookup then leaves nothing in KV.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(req, handle, {
    scope: form.getAll("scope").map(String),
  });

  // Only now, with consent recorded, do we send the user to MyAnimeList.
  const verifier = createCodeVerifier();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  headers.set("Location", malAuthorizeUrl(env, state, verifier));
  return new Response(null, { status: 302, headers });
}

async function handleMalCallback(req: Request, env: HandlerEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);

  const params = new URL(req.url).searchParams;
  if (params.get("error")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const code = params.get("code");
  if (!code) {
    headers.set("Location", authorizationErrorRedirect(original, "invalid_request"));
    return new Response(null, { status: 302, headers });
  }

  let tokens;
  let identity;
  try {
    tokens = await exchangeCode(env, code, data.verifier);
    identity = await fetchMalIdentity(tokens.accessToken);
  } catch (error) {
    if (error instanceof MalAuthError) {
      return errorPage("MyAnimeList could not complete the sign-in: " + error.message, 502);
    }
    throw error;
  }

  const props: Props = {
    malUserId: identity.id,
    malUserName: identity.name,
    malAccessToken: tokens.accessToken,
    malRefreshToken: tokens.refreshToken,
    malExpiresAt: tokens.expiresAt,
  };

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(identity.id),
    metadata: { name: identity.name },
    scope: original.scope,
    props,
  });

  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

function landingPage(): Response {
  return new Response(
    page(
      `<h1>MyAnimeList connector</h1>
       <p>A remote MCP server that connects Claude to your MyAnimeList account: your list,
          your scores, your progress, and an honest answer to "what should I watch next?"</p>
       <p class="muted">Add it in Claude as a custom connector, using this address with
          <code>/mcp</code> on the end.</p>`,
      "MyAnimeList connector",
    ),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/** Everything that is not the MCP endpoint: consent page, MAL callback, landing page. */
export const defaultHandler = {
  async fetch(req: Request, env: HandlerEnv): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/authorize") return await handleAuthorize(req, env);
      if (url.pathname === malCallbackPath) return await handleMalCallback(req, env);
      if (url.pathname === "/") return landingPage();
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError) return errorPage(error.description);
      if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
      throw error;
    }
  },
};

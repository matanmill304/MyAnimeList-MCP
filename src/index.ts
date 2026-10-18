/**
 * Worker entry point.
 *
 * This Worker plays two OAuth roles at once:
 *   - authorization server for MCP clients (Claude), with dynamic client
 *     registration, which is what the Claude connector directory requires;
 *   - OAuth client of MyAnimeList, which supports neither DCR nor a
 *     non-`plain` PKCE method, so it can never face Claude directly.
 *
 * Everything under /mcp is the MCP endpoint. Everything else — the consent
 * page, the MyAnimeList callback, the landing page — is in authorize.ts.
 */
import { OAuthProvider, OAuthError } from "@cloudflare/workers-oauth-provider";
import type { Env, HandlerEnv, Props } from "./env.js";
import { SCOPES } from "./env.js";
import { defaultHandler } from "./authorize.js";
import { MalAuthError, refreshTokens } from "./mal-oauth.js";
import { mcpApiHandler } from "./mcp.js";

/** Refresh the MyAnimeList token when it has less than this long to live. */
const MAL_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildProvider(env: Env): OAuthProvider<HandlerEnv> {
  const origin = env.PUBLIC_URL.replace(/\/$/, "");

  return new OAuthProvider<HandlerEnv>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPES.read, SCOPES.write, SCOPES.offline],
    requiredScopes: [SCOPES.read],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    },

    // Our own access tokens are short-lived, so Claude refreshes often; each
    // refresh is our chance to roll the MyAnimeList token forward before it
    // expires. MAL rotates refresh tokens, so the new pair must be persisted.
    accessTokenTTL: 60 * 60,

    async tokenExchangeCallback({ grantType, props, env: callbackEnv }) {
      if (grantType !== "refresh_token") return;

      const current = props as Props;
      if (current.malExpiresAt - Date.now() > MAL_REFRESH_MARGIN_MS) return;

      try {
        const rolled = await refreshTokens(callbackEnv, current.malRefreshToken);
        return {
          newProps: {
            ...current,
            malAccessToken: rolled.accessToken,
            malRefreshToken: rolled.refreshToken,
            malExpiresAt: rolled.expiresAt,
          } satisfies Props,
        };
      } catch (error) {
        // invalid_grant tells the library this grant can never work again, so
        // it is revoked and Claude re-authorizes instead of retrying forever.
        if (error instanceof MalAuthError && error.status >= 400 && error.status < 500) {
          throw new OAuthError("invalid_grant", {
            description: "MyAnimeList access was revoked or expired. Please reconnect the connector.",
          });
        }
        throw new OAuthError("temporarily_unavailable", {
          description: "MyAnimeList is not responding. Please try again shortly.",
          statusCode: 503,
        });
      }
    },
  });
}

let provider: OAuthProvider<HandlerEnv> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Built lazily because resourceMetadata needs PUBLIC_URL from the environment.
    provider ??= buildProvider(env);
    return provider.fetch(request, env as HandlerEnv, ctx);
  },
};

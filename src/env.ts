export interface Env {
  OAUTH_KV: KVNamespace;
  /** Public origin of this Worker, e.g. https://mal.example.com (no trailing slash). */
  PUBLIC_URL: string;
  /** Catalog mirror base, e.g. https://api.tenrai.org/v1 */
  CATALOG_BASE_URL: string;
  MAL_CLIENT_ID: string;
  MAL_CLIENT_SECRET: string;
}

/**
 * What we persist per authorized user. The OAuth library encrypts this at
 * rest with a key only the bearer token can unwrap, so a KV dump reveals
 * nothing: we never hold a readable MyAnimeList token.
 */
export interface Props extends Record<string, unknown> {
  malUserId: number;
  malUserName: string;
  malAccessToken: string;
  malRefreshToken: string;
  /** Epoch ms. MAL access tokens run ~1 month in practice. */
  malExpiresAt: number;
}

export const SCOPES = {
  read: "mcp:read",
  write: "mcp:write",
  offline: "offline_access",
} as const;

/**
 * What handlers actually receive. The OAuth provider injects itself into the
 * environment before calling the default handler, so this is the real shape
 * inside a request — Env above is just the configured bindings.
 */
export type HandlerEnv = Env & { OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers };

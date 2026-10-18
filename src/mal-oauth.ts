/**
 * MyAnimeList as the identity provider.
 *
 * MAL does not support dynamic client registration, and its PKCE
 * implementation accepts only the `plain` method (code_challenge ==
 * code_verifier) — so this Worker registers once as a MAL app of type `web`
 * (a confidential client, with a secret) and brokers for every Claude user.
 *
 * Reference: https://myanimelist.net/apiconfig/references/authorization
 */
import type { Env } from "./env.js";

const AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";

export const malCallbackPath = "/callback/mal";

export function malRedirectUri(env: Env): string {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}${malCallbackPath}`;
}

/** MAL requires a 43–128 character verifier; `plain` means challenge == verifier. */
export function createCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function malAuthorizeUrl(env: Env, state: string, codeVerifier: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.MAL_CLIENT_ID);
  url.searchParams.set("code_challenge", codeVerifier);
  url.searchParams.set("code_challenge_method", "plain");
  url.searchParams.set("redirect_uri", malRedirectUri(env));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface MalTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface MalTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  message?: string;
}

async function postToken(env: Env, body: Record<string, string>): Promise<MalTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  let parsed: MalTokenResponse;
  try {
    parsed = (await res.json()) as MalTokenResponse;
  } catch {
    throw new MalAuthError(`MyAnimeList returned a non-JSON token response (HTTP ${res.status})`, res.status);
  }

  if (!res.ok || !parsed.access_token || !parsed.refresh_token) {
    throw new MalAuthError(
      parsed.message || parsed.error || `MyAnimeList rejected the token request (HTTP ${res.status})`,
      res.status,
      parsed.error,
    );
  }

  // MAL's docs claim 1 hour but the real `expires_in` is ~28 days; trust the
  // response and fall back to an hour so a missing field fails safe (early
  // refresh) rather than late (expired token in hand).
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export class MalAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MalAuthError";
  }
}

export function exchangeCode(env: Env, code: string, codeVerifier: string): Promise<MalTokens> {
  return postToken(env, {
    client_id: env.MAL_CLIENT_ID,
    client_secret: env.MAL_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: malRedirectUri(env),
  });
}

export function refreshTokens(env: Env, refreshToken: string): Promise<MalTokens> {
  return postToken(env, {
    client_id: env.MAL_CLIENT_ID,
    client_secret: env.MAL_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** Identify who just logged in, so grants are keyed to a real MAL account. */
export async function fetchMalIdentity(accessToken: string): Promise<{ id: number; name: string }> {
  const res = await fetch("https://api.myanimelist.net/v2/users/@me?fields=id,name", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new MalAuthError(`Could not read the MyAnimeList profile (HTTP ${res.status})`, res.status);
  }
  const user = (await res.json()) as { id?: number; name?: string };
  if (typeof user.id !== "number" || !user.name) {
    throw new MalAuthError("MyAnimeList returned a profile without an id or name", 502);
  }
  return { id: user.id, name: user.name };
}

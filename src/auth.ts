import { randomBase64Url, sha256Base64Url } from "./crypto";
import { AppError, badRequest } from "./errors";
import { jsonResponse, readJsonObject } from "./http";
import {
  getOAuthClientId,
  getOAuthIssuer,
  getOAuthScope,
  normalizeOAuthCredential,
  parseCpaCredential,
  validateTokenEndpoint,
} from "./credentials";
import {
  consumeOAuthState,
  getCredentialStatus,
  saveOAuthState,
  storeCredential,
} from "./coordinator";
import type { Env, OAuthMetadata } from "./types";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function validateOAuthEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new AppError(502, "oauth_metadata_invalid", "xAI OAuth metadata is incomplete", "upstream_error");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(502, "oauth_metadata_invalid", "xAI OAuth metadata is invalid", "upstream_error");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "auth.x.ai" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError(502, "oauth_metadata_invalid", `xAI OAuth ${field} is not an allowed URL`, "upstream_error");
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("invalid_redirect_uri", "OAUTH_REDIRECT_URI must be a valid URL");
  }
  const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw badRequest("invalid_redirect_uri", "OAUTH_REDIRECT_URI must use HTTPS except for local development");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw badRequest("invalid_redirect_uri", "OAUTH_REDIRECT_URI contains unsupported URL parts");
  }
  return parsed.toString();
}

export async function discoverOAuthMetadata(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  const issuer = getOAuthIssuer(env);
  let response: Response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AppError(502, "oauth_metadata_unavailable", "Unable to reach xAI OAuth metadata", "upstream_error");
  }
  if (!response.ok) {
    throw new AppError(502, "oauth_metadata_unavailable", "xAI OAuth metadata request failed", "upstream_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AppError(502, "oauth_metadata_invalid", "xAI OAuth metadata is invalid", "upstream_error");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(502, "oauth_metadata_invalid", "xAI OAuth metadata is invalid", "upstream_error");
  }
  const record = value as Record<string, unknown>;
  return {
    authorization_endpoint: validateOAuthEndpoint(record.authorization_endpoint, "authorization endpoint"),
    token_endpoint: validateTokenEndpoint(
      validateOAuthEndpoint(record.token_endpoint, "token endpoint"),
      "token endpoint",
    ),
    issuer: typeof record.issuer === "string" ? record.issuer : issuer,
  };
}

export async function handleAuthStart(env: Env, id: string): Promise<Response> {
  if (!env.OAUTH_REDIRECT_URI) {
    throw new AppError(500, "oauth_not_configured", "OAUTH_REDIRECT_URI is not configured", "server_error");
  }
  const redirectUri = validateRedirectUri(env.OAUTH_REDIRECT_URI);
  const metadata = await discoverOAuthMetadata(env);
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const createdAt = Date.now();
  const expiresAt = createdAt + OAUTH_STATE_TTL_MS;
  await saveOAuthState(env, {
    state,
    codeVerifier,
    redirectUri,
    issuer: metadata.issuer || getOAuthIssuer(env),
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    clientId: getOAuthClientId(env),
    scope: getOAuthScope(env),
    createdAt,
    expiresAt,
  });

  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", getOAuthClientId(env));
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", getOAuthScope(env));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return jsonResponse(
    {
      authorization_url: authorizationUrl.toString(),
      expires_at: new Date(expiresAt).toISOString(),
    },
    200,
    id,
  );
}

function decodeJwtPayload(value: string): Record<string, unknown> {
  const parts = value.split(".");
  if (parts.length !== 3) return {};
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function handleAuthCallback(request: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) {
    if (stateValue) {
      await consumeOAuthState(env, stateValue).catch(() => undefined);
    }
    throw new AppError(400, "oauth_denied", "xAI OAuth authorization was not completed");
  }
  if (!stateValue || !code) {
    throw badRequest("invalid_oauth_callback", "OAuth callback requires code and state");
  }

  const state = await consumeOAuthState(env, stateValue);
  const redirectUri = validateRedirectUri(state.redirectUri);
  const tokenEndpoint = validateTokenEndpoint(state.tokenEndpoint, "oauth_state.token_endpoint");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: state.clientId,
    code_verifier: state.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch {
    throw new AppError(502, "oauth_token_exchange_failed", "Unable to reach the xAI OAuth token endpoint", "upstream_error");
  }
  if (!response.ok) {
    throw new AppError(502, "oauth_token_exchange_failed", "The xAI OAuth token exchange was rejected", "upstream_error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, "oauth_token_exchange_failed", "The xAI OAuth token response was invalid", "upstream_error");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError(502, "oauth_token_exchange_failed", "The xAI OAuth token response was invalid", "upstream_error");
  }
  const tokenPayload = payload as Record<string, unknown>;
  const idClaims = typeof tokenPayload.id_token === "string" ? decodeJwtPayload(tokenPayload.id_token) : {};
  const credential = normalizeOAuthCredential(tokenPayload, env, {
    tokenEndpoint,
    email: typeof idClaims.email === "string" ? idClaims.email : undefined,
    subject: typeof idClaims.sub === "string" ? idClaims.sub : undefined,
  });
  await storeCredential(env, credential);
  const status = await getCredentialStatus(env);
  return jsonResponse({ ok: true, status: status.status }, 200, id);
}

export async function handleAuthStatus(env: Env, id: string): Promise<Response> {
  const status = await getCredentialStatus(env);
  return jsonResponse(status, 200, id);
}

export async function handleCredentialImport(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJsonObject(request, 2_000_000);
  const credential = parseCpaCredential(body);
  await storeCredential(env, credential);
  const status = await getCredentialStatus(env);
  return jsonResponse({ ok: true, status: status.status }, 200, id);
}

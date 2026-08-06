import { AppError, badRequest, internalError } from "./errors";
import type { CredentialStatus, Env, StoredCredential } from "./types";

export const CREDENTIAL_STORAGE_KEY = "xai:credential";
export const CREDENTIAL_REFRESH_SKEW_MS = 120_000;
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const DEFAULT_XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const DEFAULT_XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const DEFAULT_XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const DEFAULT_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

const ALLOWED_BASE_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);
const ALLOWED_TOKEN_HOSTS = new Set(["auth.x.ai"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest("invalid_credential", `Credential field ${field} is required`);
  }
  return value.trim();
}

function parseFinitePositiveNumber(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw badRequest("invalid_credential", `Credential field ${field} must be a positive number`);
  }
  return numberValue;
}

function parseTimestamp(value: unknown, field: string): number {
  const text = requiredString(value, field);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw badRequest("invalid_credential", `Credential field ${field} must be an ISO date`);
  }
  return timestamp;
}

function validateHttpsUrl(value: string, field: string, allowedHosts: Set<string>): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("invalid_credential", `Credential field ${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw badRequest("invalid_credential", `Credential field ${field} uses an unsupported host`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw badRequest("invalid_credential", `Credential field ${field} contains unsupported URL parts`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateBaseUrl(value: string, field = "base_url"): string {
  const normalized = validateHttpsUrl(value, field, ALLOWED_BASE_HOSTS);
  const pathname = new URL(normalized).pathname.replace(/\/$/, "");
  if (pathname !== "/v1") {
    throw badRequest("invalid_credential", `Credential field ${field} must point to the v1 API`);
  }
  return normalized;
}

export function validateTokenEndpoint(value: string, field = "token_endpoint"): string {
  return validateHttpsUrl(value, field, ALLOWED_TOKEN_HOSTS);
}

function getExpiry(raw: Record<string, unknown>, expiresIn: number): { expiresAt: number; lastRefreshAt: number } {
  const lastRefreshAt = parseTimestamp(raw.last_refresh, "last_refresh");
  if (raw.expired !== undefined && raw.expired !== null && String(raw.expired).trim()) {
    return { expiresAt: parseTimestamp(raw.expired, "expired"), lastRefreshAt };
  }
  return { expiresAt: lastRefreshAt + expiresIn * 1000, lastRefreshAt };
}

export function parseCpaCredential(value: unknown): StoredCredential {
  if (!isRecord(value)) {
    throw badRequest("invalid_credential", "CPA credential must be a JSON object");
  }
  if (value.type !== "xai" || value.auth_kind !== "oauth" || value.token_type !== "Bearer") {
    throw badRequest("invalid_credential", "CPA credential is not an xAI OAuth credential");
  }
  if (typeof value.disabled !== "boolean") {
    throw badRequest("invalid_credential", "Credential field disabled must be boolean");
  }
  if (value.disabled === true) {
    throw badRequest("disabled_credential", "The CPA credential is disabled");
  }

  const accessToken = requiredString(value.access_token, "access_token");
  const refreshToken = requiredString(value.refresh_token, "refresh_token");
  const baseUrl = validateBaseUrl(requiredString(value.base_url, "base_url"));
  const tokenEndpoint = validateTokenEndpoint(
    typeof value.token_endpoint === "string" && value.token_endpoint.trim()
      ? value.token_endpoint
      : DEFAULT_XAI_TOKEN_ENDPOINT,
  );
  if (typeof value.expires_in !== "number") {
    throw badRequest("invalid_credential", "Credential field expires_in must be a number");
  }
  const expiresIn = parseFinitePositiveNumber(value.expires_in, "expires_in");
  const { expiresAt, lastRefreshAt } = getExpiry(value, expiresIn);

  return {
    provider: "xai",
    accessToken,
    refreshToken,
    idToken: typeof value.id_token === "string" && value.id_token ? value.id_token : undefined,
    tokenType: "Bearer",
    baseUrl,
    tokenEndpoint,
    expiresAt,
    lastRefreshAt,
    expiresIn,
    subject: typeof value.sub === "string" ? value.sub : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
  };
}

export function credentialNeedsRefresh(credential: StoredCredential, now = Date.now()): boolean {
  return credential.expiresAt - now <= CREDENTIAL_REFRESH_SKEW_MS;
}

export function credentialStatus(
  credential: StoredCredential | null,
  now = Date.now(),
): CredentialStatus {
  if (!credential) return { configured: false };
  return {
    configured: true,
    provider: credential.provider,
    baseUrl: credential.baseUrl,
    tokenEndpoint: credential.tokenEndpoint,
    expiresAt: new Date(credential.expiresAt).toISOString(),
    expiresInSeconds: Math.max(0, Math.floor((credential.expiresAt - now) / 1000)),
    needsRefresh: credentialNeedsRefresh(credential, now),
    email: credential.email,
    subject: credential.subject,
  };
}

function tokenResponseNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export async function refreshCredential(
  credential: StoredCredential,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredCredential> {
  const endpoint = validateTokenEndpoint(credential.tokenEndpoint, "token_endpoint");
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: env.XAI_OAUTH_CLIENT_ID || DEFAULT_XAI_OAUTH_CLIENT_ID,
  });

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch {
    throw new AppError(502, "credential_refresh_failed", "Unable to refresh the xAI credential", "upstream_error");
  }

  if (!response.ok) {
    throw new AppError(502, "credential_refresh_failed", "The xAI credential refresh was rejected", "upstream_error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, "credential_refresh_failed", "The xAI refresh response was invalid", "upstream_error");
  }
  if (!isRecord(payload)) {
    throw new AppError(502, "credential_refresh_failed", "The xAI refresh response was invalid", "upstream_error");
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new AppError(502, "credential_refresh_failed", "The xAI refresh response had no access token", "upstream_error");
  }
  const expiresIn = tokenResponseNumber(payload.expires_in) ?? credential.expiresIn ?? 3600;
  const now = Date.now();

  return {
    ...credential,
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : credential.refreshToken,
    idToken: typeof payload.id_token === "string" && payload.id_token.trim()
      ? payload.id_token.trim()
      : credential.idToken,
    tokenType: payload.token_type === "Bearer" || payload.token_type === undefined
      ? "Bearer"
      : (() => { throw new AppError(502, "credential_refresh_failed", "The xAI refresh response used an unsupported token type", "upstream_error"); })(),
    expiresAt: now + expiresIn * 1000,
    lastRefreshAt: now,
    expiresIn,
  };
}

export function normalizeOAuthCredential(
  value: Record<string, unknown>,
  env: Env,
  metadata: { tokenEndpoint?: string; email?: string; subject?: string } = {},
): StoredCredential {
  const accessToken = requiredString(value.access_token, "access_token");
  const refreshToken = requiredString(value.refresh_token, "refresh_token");
  const expiresIn = parseFinitePositiveNumber(value.expires_in ?? 21600, "expires_in");
  const baseUrl = validateBaseUrl(env.XAI_API_BASE_URL || DEFAULT_XAI_BASE_URL, "base_url");
  const tokenEndpoint = validateTokenEndpoint(
    metadata.tokenEndpoint || (typeof value.token_endpoint === "string" ? value.token_endpoint : DEFAULT_XAI_TOKEN_ENDPOINT),
  );
  const now = Date.now();
  return {
    provider: "xai",
    accessToken,
    refreshToken,
    idToken: typeof value.id_token === "string" ? value.id_token : undefined,
    tokenType: "Bearer",
    baseUrl,
    tokenEndpoint,
    expiresAt: now + expiresIn * 1000,
    lastRefreshAt: now,
    expiresIn,
    email: metadata.email,
    subject: metadata.subject,
  };
}

export function assertStoredCredential(value: unknown): StoredCredential {
  if (!isRecord(value) || value.provider !== "xai") {
    throw internalError("Stored credential is invalid");
  }
  const accessToken = requiredString(value.accessToken, "accessToken");
  const refreshToken = requiredString(value.refreshToken, "refreshToken");
  const baseUrl = validateBaseUrl(requiredString(value.baseUrl, "baseUrl"), "baseUrl");
  const tokenEndpoint = validateTokenEndpoint(requiredString(value.tokenEndpoint, "tokenEndpoint"), "tokenEndpoint");
  const expiresAt = Number(value.expiresAt);
  const lastRefreshAt = Number(value.lastRefreshAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(lastRefreshAt)) {
    throw internalError("Stored credential has invalid timestamps");
  }
  return {
    provider: "xai",
    accessToken,
    refreshToken,
    idToken: typeof value.idToken === "string" ? value.idToken : undefined,
    tokenType: "Bearer",
    baseUrl,
    tokenEndpoint,
    expiresAt,
    lastRefreshAt,
    expiresIn: tokenResponseNumber(value.expiresIn),
    subject: typeof value.subject === "string" ? value.subject : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
  };
}

export function getOAuthIssuer(env: Env): string {
  const issuer = env.XAI_OAUTH_ISSUER || DEFAULT_XAI_OAUTH_ISSUER;
  return validateHttpsUrl(issuer, "XAI_OAUTH_ISSUER", new Set(["auth.x.ai"]));
}

export function getOAuthClientId(env: Env): string {
  return env.XAI_OAUTH_CLIENT_ID || DEFAULT_XAI_OAUTH_CLIENT_ID;
}

export function getOAuthScope(env: Env): string {
  return env.XAI_OAUTH_SCOPE || DEFAULT_XAI_OAUTH_SCOPE;
}

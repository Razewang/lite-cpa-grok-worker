export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

export interface Env {
  CREDENTIALS_KV: KVNamespace;
  CREDENTIAL_COORDINATOR: DurableObjectNamespace;
  CLIENT_API_KEY: string;
  ADMIN_API_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  TEXT_UPSTREAM_PROFILE?: string;
  MEDIA_BASE_URL?: string;
  CLI_PROXY_BASE_URL?: string;
  CLI_PROXY_CLIENT_VERSION?: string;
  XAI_OAUTH_ISSUER?: string;
  XAI_OAUTH_CLIENT_ID?: string;
  XAI_OAUTH_SCOPE?: string;
  OAUTH_REDIRECT_URI?: string;
  XAI_API_BASE_URL?: string;
}

export interface CpaXaiCredentialFile {
  access_token: string;
  auth_kind: "oauth";
  base_url: string;
  disabled: boolean;
  email: string;
  expired: string;
  expires_in: number;
  id_token: string;
  last_refresh: string;
  refresh_token: string;
  sub: string;
  token_endpoint: string;
  token_type: "Bearer";
  type: "xai";
}

export interface StoredCredential {
  provider: "xai";
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  tokenType: "Bearer";
  baseUrl: string;
  tokenEndpoint: string;
  expiresAt: number;
  lastRefreshAt: number;
  expiresIn?: number;
  subject?: string;
  email?: string;
}

export interface CredentialStatus {
  configured: boolean;
  provider?: "xai";
  baseUrl?: string;
  tokenEndpoint?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  needsRefresh?: boolean;
  email?: string;
  subject?: string;
}

export interface OAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer?: string;
}

export interface ResolvedCredentialResult {
  credential: StoredCredential;
  refreshed: boolean;
}


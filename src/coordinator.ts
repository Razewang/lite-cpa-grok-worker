import { decryptCredential, encryptCredential } from "./crypto";
import { AppError, badRequest, internalError } from "./errors";
import { errorResponse, jsonResponse, readJsonObject, requestId } from "./http";
import {
  assertStoredCredential,
  CREDENTIAL_STORAGE_KEY,
  credentialNeedsRefresh,
  credentialStatus,
  refreshCredential,
} from "./credentials";
import type { Env, OAuthState, ResolvedCredentialResult, StoredCredential } from "./types";

const OAUTH_STATE_PREFIX = "oauth:";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function coordinatorErrorResponse(error: unknown, id: string): Response {
  return errorResponse(error, id);
}

export class CredentialCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const id = requestId(request);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/store" && request.method === "POST") {
        return await this.store(request, id);
      }
      if (url.pathname === "/resolve" && request.method === "GET") {
        return await this.resolve(id);
      }
      if (url.pathname === "/status" && request.method === "GET") {
        return await this.status(id);
      }
      if (url.pathname === "/oauth/state" && request.method === "POST") {
        return await this.saveOAuthState(request, id);
      }
      if (url.pathname === "/oauth/consume" && request.method === "GET") {
        return await this.consumeOAuthState(url, id);
      }
      throw new AppError(404, "not_found", "Coordinator route not found");
    } catch (error) {
      return coordinatorErrorResponse(error, id);
    }
  }

  private async store(request: Request, id: string): Promise<Response> {
    const body = await readJsonObject(request, 1_000_000);
    const credential = assertStoredCredential(body.credential);
    const encrypted = await encryptCredential(credential, this.env.CREDENTIAL_ENCRYPTION_KEY);
    await this.env.CREDENTIALS_KV.put(CREDENTIAL_STORAGE_KEY, encrypted);
    return jsonResponse({ ok: true, status: credentialStatus(credential) }, 200, id);
  }

  private async resolve(id: string): Promise<Response> {
    let result: ResolvedCredentialResult | undefined;
    await this.state.blockConcurrencyWhile(async () => {
      const encrypted = await this.env.CREDENTIALS_KV.get(CREDENTIAL_STORAGE_KEY);
      if (!encrypted) {
        throw new AppError(503, "credential_not_configured", "No xAI credential is configured", "server_error");
      }
      const stored = await decryptCredential<StoredCredential>(
        encrypted,
        this.env.CREDENTIAL_ENCRYPTION_KEY,
      );
      let credential = assertStoredCredential(stored);
      let refreshed = false;
      if (credentialNeedsRefresh(credential)) {
        credential = await refreshCredential(credential, this.env);
        const nextEncrypted = await encryptCredential(credential, this.env.CREDENTIAL_ENCRYPTION_KEY);
        await this.env.CREDENTIALS_KV.put(CREDENTIAL_STORAGE_KEY, nextEncrypted);
        refreshed = true;
      }
      result = { credential, refreshed };
    });

    if (!result) throw internalError("Credential coordinator returned no credential");
    return jsonResponse(result, 200, id);
  }

  private async status(id: string): Promise<Response> {
    const encrypted = await this.env.CREDENTIALS_KV.get(CREDENTIAL_STORAGE_KEY);
    if (!encrypted) return jsonResponse({ status: credentialStatus(null) }, 200, id);
    const stored = await decryptCredential<StoredCredential>(
      encrypted,
      this.env.CREDENTIAL_ENCRYPTION_KEY,
    );
    const credential = assertStoredCredential(stored);
    return jsonResponse({ status: credentialStatus(credential) }, 200, id);
  }

  private async saveOAuthState(request: Request, id: string): Promise<Response> {
    const body = await readJsonObject(request, 32_000);
    const state = parseOAuthState(body.state);
    if (state.expiresAt <= Date.now() || state.expiresAt > Date.now() + OAUTH_STATE_TTL_MS) {
      throw badRequest("invalid_oauth_state", "OAuth state expiry is invalid");
    }
    await this.state.storage.put(`${OAUTH_STATE_PREFIX}${state.state}`, state);
    return jsonResponse({ ok: true }, 200, id);
  }

  private async consumeOAuthState(url: URL, id: string): Promise<Response> {
    const stateValue = url.searchParams.get("state");
    if (!stateValue || !/^[A-Za-z0-9_-]{16,256}$/.test(stateValue)) {
      throw badRequest("invalid_oauth_state", "OAuth state is invalid");
    }
    let state: OAuthState | undefined;
    await this.state.blockConcurrencyWhile(async () => {
      state = await this.state.storage.get<OAuthState>(`${OAUTH_STATE_PREFIX}${stateValue}`);
      await this.state.storage.delete(`${OAUTH_STATE_PREFIX}${stateValue}`);
    });
    if (!state || state.expiresAt <= Date.now()) {
      throw new AppError(400, "expired_oauth_state", "OAuth state is missing or expired");
    }
    return jsonResponse({ state }, 200, id);
  }
}

function parseOAuthState(value: unknown): OAuthState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("invalid_oauth_state", "OAuth state is invalid");
  }
  const record = value as Record<string, unknown>;
  const stringFields = [
    "state",
    "codeVerifier",
    "redirectUri",
    "issuer",
    "authorizationEndpoint",
    "tokenEndpoint",
    "clientId",
    "scope",
  ] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw badRequest("invalid_oauth_state", "OAuth state is incomplete");
    }
  }
  const createdAt = Number(record.createdAt);
  const expiresAt = Number(record.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw badRequest("invalid_oauth_state", "OAuth state timestamps are invalid");
  }
  return {
    state: record.state as string,
    codeVerifier: record.codeVerifier as string,
    redirectUri: record.redirectUri as string,
    issuer: record.issuer as string,
    authorizationEndpoint: record.authorizationEndpoint as string,
    tokenEndpoint: record.tokenEndpoint as string,
    clientId: record.clientId as string,
    scope: record.scope as string,
    createdAt,
    expiresAt,
  };
}

export function coordinatorStub(env: Env): DurableObjectStub {
  const id = env.CREDENTIAL_COORDINATOR.idFromName("default");
  return env.CREDENTIAL_COORDINATOR.get(id);
}

async function coordinatorRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await coordinatorStub(env).fetch(`https://coordinator.internal${path}`, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, "coordinator_error", "Credential coordinator returned an invalid response", "server_error");
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      && typeof (payload as { error?: unknown }).error === "object"
      && (payload as { error?: { message?: unknown } }).error
      && typeof (payload as { error: { message?: unknown } }).error.message === "string"
      ? (payload as { error: { message: string } }).error.message
      : "Credential coordinator request failed";
    throw new AppError(response.status, "coordinator_error", message, "server_error");
  }
  return payload as T;
}

export async function storeCredential(env: Env, credential: StoredCredential): Promise<void> {
  await coordinatorRequest(env, "/store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
}

export async function resolveCredential(env: Env): Promise<ResolvedCredentialResult> {
  return coordinatorRequest<ResolvedCredentialResult>(env, "/resolve");
}

export async function getCredentialStatus(env: Env): Promise<{ status: ReturnType<typeof credentialStatus> }> {
  return coordinatorRequest(env, "/status");
}

export async function saveOAuthState(env: Env, state: OAuthState): Promise<void> {
  await coordinatorRequest(env, "/oauth/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

export async function consumeOAuthState(env: Env, state: string): Promise<OAuthState> {
  const response = await coordinatorRequest<{ state: OAuthState }>(
    env,
    `/oauth/consume?state=${encodeURIComponent(state)}`,
  );
  return response.state;
}

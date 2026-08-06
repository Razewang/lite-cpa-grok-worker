import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialCoordinator } from "../src/coordinator";
import { encryptCredential } from "../src/crypto";
import { parseCpaCredential } from "../src/credentials";
import type { Env, StoredCredential } from "../src/types";

const fixture = parseCpaCredential({
  access_token: "fixture-access-token",
  auth_kind: "oauth",
  base_url: "https://api.x.ai/v1",
  disabled: false,
  email: "owner@example.test",
  expired: "2020-01-01T00:00:00.000Z",
  expires_in: 3600,
  id_token: "fixture-id-token",
  last_refresh: "2019-12-31T23:00:00.000Z",
  refresh_token: "fixture-refresh-token",
  sub: "fixture-subject",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  token_type: "Bearer",
  type: "xai",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CredentialCoordinator", () => {
  it("refreshes a concurrently requested credential only once", async () => {
    let encrypted = await encryptCredential(fixture, "fixture-encryption-secret");
    let refreshCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }), { headers: { "content-type": "application/json" } });
    }));

    const storageMap = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string) { return storageMap.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { storageMap.set(key, value); },
      async delete(key: string) { return storageMap.delete(key); },
    };
    const kv = {
      async get() { return encrypted; },
      async put(_key: string, value: string) { encrypted = value; },
    };
    let lock = Promise.resolve();
    const state = {
      storage,
      blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        const run = lock.then(callback);
        lock = run.then(() => undefined, () => undefined);
        return run;
      },
    } as unknown as DurableObjectState;
    const env = {
      CREDENTIALS_KV: kv,
      CREDENTIAL_ENCRYPTION_KEY: "fixture-encryption-secret",
      XAI_OAUTH_CLIENT_ID: "fixture-client",
    } as unknown as Env;
    const coordinator = new CredentialCoordinator(state, env);

    const responses = await Promise.all([
      coordinator.fetch(new Request("https://coordinator/resolve")),
      coordinator.fetch(new Request("https://coordinator/resolve")),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(refreshCount).toBe(1);
  });
});


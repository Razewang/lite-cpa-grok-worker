import { describe, expect, it, vi } from "vitest";
import {
  credentialNeedsRefresh,
  parseCpaCredential,
  refreshCredential,
} from "../src/credentials";
import { decryptCredential, encryptCredential } from "../src/crypto";
import type { Env } from "../src/types";

const cpaFixture = {
  access_token: "fixture-access-token",
  auth_kind: "oauth",
  base_url: "https://api.x.ai/v1",
  disabled: false,
  email: "owner@example.test",
  expired: "2030-01-01T00:00:00.000Z",
  expires_in: 21600,
  id_token: "fixture-id-token",
  last_refresh: "2029-12-31T18:00:00.000Z",
  refresh_token: "fixture-refresh-token",
  sub: "fixture-subject",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  token_type: "Bearer",
  type: "xai",
};

const env = { XAI_OAUTH_CLIENT_ID: "fixture-client" } as Env;

describe("CPA credential adapter", () => {
  it("parses the top-level xAI OAuth format without exposing the raw shape downstream", () => {
    const credential = parseCpaCredential(cpaFixture);
    expect(credential.provider).toBe("xai");
    expect(credential.baseUrl).toBe("https://api.x.ai/v1");
    expect(credential.tokenEndpoint).toBe("https://auth.x.ai/oauth2/token");
    expect(credential.expiresAt).toBe(Date.parse(cpaFixture.expired));
    expect(credential.email).toBe(cpaFixture.email);
  });

  it("uses last_refresh plus expires_in when expired is absent", () => {
    const withoutExpired = { ...cpaFixture, expired: "" };
    const credential = parseCpaCredential(withoutExpired);
    expect(credential.expiresAt).toBe(Date.parse(cpaFixture.last_refresh) + cpaFixture.expires_in * 1000);
  });

  it("rejects arbitrary upstream hosts", () => {
    expect(() => parseCpaCredential({ ...cpaFixture, base_url: "https://attacker.example/v1" })).toThrow(
      "unsupported host",
    );
  });

  it("refreshes with the credential endpoint and preserves rotated refresh tokens", async () => {
    const credential = parseCpaCredential({ ...cpaFixture, expired: "2020-01-01T00:00:00.000Z" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = String(init?.body || "");
      expect(form).toContain("grant_type=refresh_token");
      expect(form).toContain("client_id=fixture-client");
      expect(form).toContain("refresh_token=fixture-refresh-token");
      return new Response(JSON.stringify({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }), { headers: { "content-type": "application/json" } });
    });
    const refreshed = await refreshCredential(credential, env, fetchMock as typeof fetch);
    expect(refreshed.accessToken).toBe("rotated-access-token");
    expect(refreshed.refreshToken).toBe("rotated-refresh-token");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes inside the configured skew window", () => {
    const credential = parseCpaCredential({
      ...cpaFixture,
      expired: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(credentialNeedsRefresh(credential)).toBe(true);
  });

  it("encrypts and decrypts stored credentials", async () => {
    const credential = parseCpaCredential(cpaFixture);
    const encoded = await encryptCredential(credential, "fixture-encryption-secret");
    expect(encoded.startsWith("v1.")).toBe(true);
    expect(encoded).not.toContain(credential.accessToken);
    const decoded = await decryptCredential<typeof credential>(encoded, "fixture-encryption-secret");
    expect(decoded).toEqual(credential);
  });
});

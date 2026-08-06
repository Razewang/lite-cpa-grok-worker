import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env, StoredCredential } from "../src/types";

const storedCredential: StoredCredential = {
  provider: "xai",
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  tokenType: "Bearer",
  baseUrl: "https://api.x.ai/v1",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  expiresAt: Date.now() + 3_600_000,
  lastRefreshAt: Date.now(),
  expiresIn: 3600,
};

function createEnv() {
  let configured = storedCredential;
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/resolve") {
        return Response.json({ credential: configured, refreshed: false });
      }
      if (url.pathname === "/status") {
        return Response.json({ status: { configured: true, provider: "xai", baseUrl: configured.baseUrl } });
      }
      if (url.pathname === "/store") {
        const body = await request.json() as { credential: StoredCredential };
        configured = body.credential;
        return Response.json({ ok: true });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  };
  const namespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => stub,
  };
  return {
    env: {
      CREDENTIALS_KV: {} as KVNamespace,
      CREDENTIAL_COORDINATOR: namespace as unknown as DurableObjectNamespace,
      CLIENT_API_KEY: "client-key",
      ADMIN_API_KEY: "admin-key",
      CREDENTIAL_ENCRYPTION_KEY: "fixture-encryption-secret",
      TEXT_UPSTREAM_PROFILE: "credential",
      CLI_PROXY_BASE_URL: "https://cli-chat-proxy.grok.com/v1",
    } as Env,
    getCredential: () => configured,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker routes", () => {
  it("serves health without an API key", async () => {
    const { env } = createEnv();
    const response = await worker.fetch(new Request("https://worker.test/health"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("keeps admin and client keys separate", async () => {
    const { env } = createEnv();
    const response = await worker.fetch(new Request("https://worker.test/v1/models", {
      headers: { authorization: "Bearer admin-key" },
    }), env);
    expect(response.status).toBe(401);
  });

  it("proxies models with the stored credential", async () => {
    const { env } = createEnv();
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, headers: request.headers });
      return new Response(JSON.stringify({ object: "list", data: [{ id: "grok-4" }] }), {
        headers: { "content-type": "application/json" },
      });
    }));
    const response = await worker.fetch(new Request("https://worker.test/v1/models", {
      headers: { authorization: "Bearer client-key" },
    }), env);
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe("https://api.x.ai/v1/models");
    expect(calls[0].headers.get("authorization")).toBe("Bearer fixture-access-token");
  });

  it("packs Responses requests and aggregates non-streaming clients", async () => {
    const { env } = createEnv();
    let sentBody: Record<string, unknown> | undefined;
    let upstreamRequest: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      upstreamRequest = request;
      sentBody = await request.json() as Record<string, unknown>;
      return new Response(
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"output\":[]}}\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    }));
    const response = await worker.fetch(new Request("https://worker.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "grok/grok-4-latest", instructions: null, input: "hi", prompt_cache_key: "conv-fixture", stream: false }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "resp_fixture", output: [] });
    expect(sentBody).toEqual({ model: "grok-4", instructions: "", input: "hi", stream: true });
    expect(upstreamRequest?.headers.get("x-grok-conv-id")).toBe("conv-fixture");
  });

  it("routes image generation through the media path", async () => {
    const { env } = createEnv();
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = new Request(input, init).url;
      return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
    }));
    const response = await worker.fetch(new Request("https://worker.test/v1/images/generations", {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "xai/grok-image-1", prompt: "fixture" }),
    }), env);
    expect(response.status).toBe(200);
    expect(requestedUrl).toBe("https://api.x.ai/v1/images/generations");
  });

  it("uses the exact CLI Proxy base URL and compatibility headers when selected", async () => {
    const { env } = createEnv();
    env.TEXT_UPSTREAM_PROFILE = "cli-proxy";
    let upstreamRequest: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamRequest = new Request(input, init);
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }));
    const response = await worker.fetch(new Request("https://worker.test/v1/models", {
      headers: { authorization: "Bearer client-key" },
    }), env);
    expect(response.status).toBe(200);
    expect(upstreamRequest?.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(upstreamRequest?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(upstreamRequest?.headers.get("x-grok-client-version")).toBe("0.2.93");
  });
});

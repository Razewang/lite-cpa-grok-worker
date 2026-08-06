import { handleAuthCallback, handleAuthStart, handleAuthStatus, handleCredentialImport } from "./auth";
import { CredentialCoordinator } from "./coordinator";
import { methodNotAllowed, notFound, unauthorized } from "./errors";
import { errorResponse, isAuthorized, jsonResponse, requestId } from "./http";
import { handleImages } from "./images";
import { handleModels } from "./models";
import { handleResponses } from "./responses";
import type { Env } from "./types";

const SERVICE_VERSION = "0.1.0";

function healthResponse(env: Env, id: string): Response {
  return jsonResponse(
    {
      status: "ok",
      service: "lite-cpa-grok-worker",
      version: SERVICE_VERSION,
      text_upstream_profile: env.TEXT_UPSTREAM_PROFILE === "cli-proxy" ? "cli-proxy" : "credential",
    },
    200,
    id,
  );
}

function assertMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw methodNotAllowed(`Expected ${expected}`);
}

async function route(request: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    assertMethod(request, "GET");
    return healthResponse(env, id);
  }

  if (url.pathname.startsWith("/admin/")) {
    if (url.pathname === "/admin/auth/callback") {
      assertMethod(request, "GET");
      return handleAuthCallback(request, env, id);
    }
    if (!isAuthorized(request, env.ADMIN_API_KEY)) throw unauthorized("Invalid admin API key");
    if (url.pathname === "/admin/credentials/import") {
      assertMethod(request, "POST");
      return handleCredentialImport(request, env, id);
    }
    if (url.pathname === "/admin/auth/start") {
      assertMethod(request, "POST");
      return handleAuthStart(env, id);
    }
    if (url.pathname === "/admin/auth/status") {
      assertMethod(request, "GET");
      return handleAuthStatus(env, id);
    }
    throw notFound("Admin route not found");
  }

  if (url.pathname.startsWith("/v1/")) {
    if (!isAuthorized(request, env.CLIENT_API_KEY)) throw unauthorized();
    if (url.pathname === "/v1/models") {
      assertMethod(request, "GET");
      return handleModels(env, id);
    }
    if (url.pathname === "/v1/responses") {
      assertMethod(request, "POST");
      return handleResponses(request, env, id);
    }
    if (url.pathname === "/v1/images/generations") {
      assertMethod(request, "POST");
      return handleImages(request, env, id, "generations");
    }
    if (url.pathname === "/v1/images/edits") {
      assertMethod(request, "POST");
      return handleImages(request, env, id, "edits");
    }
    throw notFound("API route not found");
  }

  throw notFound();
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = requestId(request);
    try {
      return await route(request, env, id);
    } catch (error) {
      return errorResponse(error, id);
    }
  },
};

export { CredentialCoordinator };
export default worker;

import { jsonResponse } from "./http";
import { UpstreamError } from "./errors";
import { resolveCredential } from "./coordinator";
import { fetchUpstream } from "./upstream";
import type { Env } from "./types";

export async function handleModels(env: Env, id: string): Promise<Response> {
  const { credential } = await resolveCredential(env);
  const upstream = await fetchUpstream(env, credential, "/models", {
    method: "GET",
    accept: "application/json",
    kind: "text",
  });
  const payload = await upstream.json().catch(() => null);
  if (payload === null) {
    throw new UpstreamError(502, "The upstream models response was invalid");
  }
  return jsonResponse(payload, 200, id);
}

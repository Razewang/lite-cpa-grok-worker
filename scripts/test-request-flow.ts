import { readFile } from "node:fs/promises";
import {
  credentialNeedsRefresh,
  parseCpaCredential,
  refreshCredential,
} from "../src/credentials";
import { collectCompletedResponse, normalizeResponsesPayload } from "../src/responses";
import { fetchUpstream } from "../src/upstream";
import type { Env, JsonObject } from "../src/types";

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value || "");
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "unknown request-flow error";
}

async function run(): Promise<void> {
  if (!enabled(process.env.LIVE_TEST)) {
    throw new Error("Live request flow is opt-in; set LIVE_TEST=1");
  }

  const credentialPath = process.env.CPA_CREDENTIAL_PATH;
  if (!credentialPath) {
    throw new Error("CPA_CREDENTIAL_PATH must point to an external CPA JSON file");
  }
  const model = process.env.LIVE_MODEL || "grok-4";
  const input = process.env.LIVE_INPUT || "Reply with the single word OK.";
  const raw = await readFile(credentialPath, "utf8");
  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch {
    throw new Error("CPA_CREDENTIAL_PATH is not valid JSON");
  }

  // This is the same adapter used by the Worker import route. The raw JSON is
  // never logged, copied, or returned from this script.
  const env = {
    TEXT_UPSTREAM_PROFILE: "credential",
    XAI_OAUTH_CLIENT_ID: process.env.XAI_OAUTH_CLIENT_ID,
  } as Env;
  let credential = parseCpaCredential(source);
  let refreshed = false;
  if (credentialNeedsRefresh(credential)) {
    credential = await refreshCredential(credential, env);
    refreshed = true;
  }

  const normalized = normalizeResponsesPayload({
    model,
    input,
    stream: false,
  } satisfies JsonObject);
  const startedAt = Date.now();
  const upstream = await fetchUpstream(env, credential, "/responses", {
    method: "POST",
    body: JSON.stringify(normalized.payload),
    accept: "text/event-stream",
    contentType: "application/json",
    kind: "text",
  });
  await collectCompletedResponse(upstream.body);

  console.log(JSON.stringify({
    ok: true,
    cpa_imported: true,
    access_key_used: true,
    refreshed,
    upstream_base_url: credential.baseUrl,
    upstream_status: upstream.status,
    response_completed: true,
    elapsed_ms: Date.now() - startedAt,
  }));
}

try {
  await run();
} catch (error) {
  console.error(`Live request flow failed: ${safeFailureMessage(error)}`);
  process.exitCode = 1;
}

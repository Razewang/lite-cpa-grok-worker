import { AppError, badRequest, UpstreamError } from "./errors";
import { jsonResponse, readJsonObject } from "./http";
import { resolveCredential } from "./coordinator";
import { fetchUpstream } from "./upstream";
import type { Env, JsonObject } from "./types";

const UNSUPPORTED_RESPONSE_FIELDS = [
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "generate",
] as const;

const MODEL_ALIASES: Record<string, string> = {
  "grok-latest": "grok-4",
  "grok-3-latest": "grok-3",
  "grok-3-mini-latest": "grok-3-mini",
  "grok-4-latest": "grok-4",
};

export interface NormalizedResponsesPayload {
  payload: JsonObject;
  clientStream: boolean;
  conversationId?: string;
}

export function normalizeModelName(value: string): string {
  let model = value.trim();
  model = model.replace(/^(?:grok|xai|x-ai)\//i, "");
  return MODEL_ALIASES[model] || model;
}

export function normalizeResponsesPayload(raw: JsonObject): NormalizedResponsesPayload {
  const payload: JsonObject = { ...raw };
  const model = payload.model;
  if (typeof model !== "string" || !model.trim()) {
    throw badRequest("missing_model", "The responses request requires a model");
  }

  const clientStream = payload.stream === true;
  payload.model = normalizeModelName(model);
  payload.instructions = payload.instructions == null ? "" : payload.instructions;

  let conversationId: string | undefined;
  if (typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim()) {
    conversationId = payload.prompt_cache_key.trim();
  }
  delete payload.prompt_cache_key;
  for (const field of UNSUPPORTED_RESPONSE_FIELDS) delete payload[field];
  payload.stream = true;

  return { payload, clientStream, conversationId };
}

interface ParsedSseEvent {
  eventName?: string;
  data: string;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join("\n") };
}

function completedValue(event: ParsedSseEvent): unknown | undefined {
  if (event.data === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    throw new UpstreamError(502, "The upstream response stream contained invalid data");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const object = parsed as Record<string, unknown>;
  if (object.type === "error" || event.eventName === "error") {
    throw new UpstreamError(502, "The upstream response stream returned an error");
  }
  if (object.type === "response.completed" || event.eventName === "response.completed") {
    return object.response ?? object;
  }
  return undefined;
}

export async function collectCompletedResponse(
  body: ReadableStream<Uint8Array> | null,
): Promise<unknown> {
  if (!body) throw new UpstreamError(502, "The upstream response stream was empty");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: unknown;
  let foundCompleted = false;

  const consumeBlock = (block: string): void => {
    const event = parseSseBlock(block);
    if (!event) return;
    const value = completedValue(event);
    if (value !== undefined) {
      completed = value;
      foundCompleted = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex: number;
    while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const separatorMatch = buffer.match(/\r?\n\r?\n/);
      const separatorLength = separatorMatch?.[0].length || 2;
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separatorLength);
      consumeBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeBlock(buffer);

  if (foundCompleted) return completed;

  const fallback = buffer.trim();
  if (fallback.startsWith("{")) {
    try {
      return JSON.parse(fallback);
    } catch {
      // The generic incomplete-stream error below avoids exposing upstream content.
    }
  }
  throw new UpstreamError(502, "The upstream response did not complete");
}

function streamingHeaders(id: string): Headers {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-store");
  headers.set("connection", "keep-alive");
  headers.set("x-accel-buffering", "no");
  headers.set("x-request-id", id);
  return headers;
}

export async function handleResponses(request: Request, env: Env, id: string): Promise<Response> {
  const raw = await readJsonObject(request, 2_000_000);
  const normalized = normalizeResponsesPayload(raw as JsonObject);
  const { credential } = await resolveCredential(env);
  const upstream = await fetchUpstream(env, credential, "/responses", {
    method: "POST",
    body: JSON.stringify(normalized.payload),
    accept: "text/event-stream",
    contentType: "application/json",
    conversationId: normalized.conversationId,
    kind: "text",
  });

  if (normalized.clientStream) {
    return new Response(upstream.body, { status: 200, headers: streamingHeaders(id) });
  }
  const response = await collectCompletedResponse(upstream.body);
  return jsonResponse(response, 200, id);
}

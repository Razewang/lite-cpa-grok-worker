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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function flattenChatStyleTool(tool: unknown): unknown {
  if (!isObject(tool)) return tool;

  if (tool.type === "function" && isObject(tool.function)) {
    const name = nonEmptyString(tool.function.name);
    if (!name) throw badRequest("invalid_tools", "Function tools require a name");
    const flattened: JsonObject = {
      type: "function",
      name,
      parameters: isObject(tool.function.parameters)
        ? tool.function.parameters
        : { type: "object", properties: {} },
    };
    if (typeof tool.function.description === "string") flattened.description = tool.function.description;
    if (typeof tool.function.strict === "boolean") flattened.strict = tool.function.strict;
    return flattened;
  }

  if (tool.type === "custom" && isObject(tool.custom)) {
    const name = nonEmptyString(tool.custom.name);
    if (!name) throw badRequest("invalid_tools", "Custom tools require a name");
    const flattened: JsonObject = { type: "custom", name };
    if (typeof tool.custom.description === "string") flattened.description = tool.custom.description;
    if (isObject(tool.custom.format)) flattened.format = tool.custom.format;
    return flattened;
  }

  return tool;
}

function flattenChatStyleToolChoice(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (value.type === "function" && isObject(value.function)) {
    const name = nonEmptyString(value.function.name);
    if (!name) throw badRequest("invalid_tool_choice", "Function tool_choice requires a name");
    return { type: "function", name };
  }
  if (value.type === "custom" && isObject(value.custom)) {
    const name = nonEmptyString(value.custom.name);
    if (!name) throw badRequest("invalid_tool_choice", "Custom tool_choice requires a name");
    return { type: "custom", name };
  }
  return value;
}

function normalizeResponseTools(payload: JsonObject): void {
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map(flattenChatStyleTool);
  }
  if (payload.tool_choice !== undefined) {
    payload.tool_choice = flattenChatStyleToolChoice(payload.tool_choice);
  }
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
  normalizeResponseTools(payload);
  payload.stream = true;

  return { payload, clientStream, conversationId };
}

export interface ParsedSseEvent {
  eventName?: string;
  data: string;
}

export function parseSseBlock(block: string): ParsedSseEvent | null {
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

function parsedEventObject(event: ParsedSseEvent): Record<string, unknown> | undefined {
  if (event.data === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    throw new UpstreamError(502, "The upstream response stream contained invalid data");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function completedValue(event: ParsedSseEvent, object: Record<string, unknown>): unknown | undefined {
  if (object.type === "error" || event.eventName === "error") {
    throw new UpstreamError(502, "The upstream response stream returned an error");
  }
  if (object.type === "response.completed" || object.type === "response.incomplete"
    || event.eventName === "response.completed" || event.eventName === "response.incomplete") {
    return object.response ?? object;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function patchCompletedOutput(
  completed: unknown,
  indexedItems: Map<number, unknown>,
  fallbackItems: unknown[],
): unknown {
  if (!isObject(completed) || (!indexedItems.size && !fallbackItems.length)) return completed;
  const output = Array.isArray(completed.output) ? [...completed.output] : [];
  for (const [index, item] of indexedItems) output[index] = item;
  const knownIds = new Set(output.flatMap((item) => {
    if (!isObject(item)) return [];
    const id = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
    return id ? [id] : [];
  }));
  for (const item of fallbackItems) {
    const id = isObject(item)
      ? typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined
      : undefined;
    if (id && knownIds.has(id)) continue;
    output.push(item);
    if (id) knownIds.add(id);
  }
  return { ...completed, output: output.filter((item) => item !== undefined) };
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
  const indexedItems = new Map<number, unknown>();
  const fallbackItems: unknown[] = [];

  const consumeBlock = (block: string): void => {
    const event = parseSseBlock(block);
    if (!event) return;
    const object = parsedEventObject(event);
    if (!object) return;
    if (object.type === "response.output_item.done" && object.item !== undefined) {
      if (typeof object.output_index === "number") indexedItems.set(object.output_index, object.item);
      else fallbackItems.push(object.item);
    }
    const value = completedValue(event, object);
    if (value !== undefined) {
      completed = patchCompletedOutput(value, indexedItems, fallbackItems);
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

export function streamingHeaders(id: string): Headers {
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

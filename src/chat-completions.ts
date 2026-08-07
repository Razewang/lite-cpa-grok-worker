import { badRequest, UpstreamError } from "./errors";
import { jsonResponse, readJsonObject } from "./http";
import { resolveCredential } from "./coordinator";
import {
  collectCompletedResponse,
  normalizeResponsesPayload,
  parseSseBlock,
  streamingHeaders,
  type ParsedSseEvent,
} from "./responses";
import { fetchUpstream } from "./upstream";
import type { Env, JsonObject } from "./types";

type JsonRecord = Record<string, unknown>;

interface ToolNameMaps {
  originalToShort: Map<string, string>;
  shortToOriginal: Map<string, string>;
}

export interface TranslatedChatPayload {
  payload: JsonObject;
  clientStream: boolean;
  includeUsage: boolean;
  toolNames: ToolNameMaps;
}

interface ChatResponseContext {
  requestedModel: string;
  requestId: string;
  includeUsage: boolean;
  toolNames: ToolNameMaps;
}

interface StreamToolState {
  index: number;
  argumentsEmitted: boolean;
  done: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return { ...value };
}

function declaredToolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  if (tool.type === "function" && isRecord(tool.function)) {
    return nonEmptyString(tool.function.name);
  }
  if (tool.type === "custom" && isRecord(tool.custom)) {
    return nonEmptyString(tool.custom.name);
  }
  return undefined;
}

function shortenToolName(name: string): string {
  const limit = 64;
  if (name.length <= limit) return name;
  if (name.startsWith("mcp__")) {
    const lastSeparator = name.lastIndexOf("__");
    if (lastSeparator > 0) return (`mcp__${name.slice(lastSeparator + 2)}`).slice(0, limit);
  }
  return name.slice(0, limit);
}

function buildToolNameMaps(tools: unknown[]): ToolNameMaps {
  const originalToShort = new Map<string, string>();
  const shortToOriginal = new Map<string, string>();
  const used = new Set<string>();

  for (const tool of tools) {
    const original = declaredToolName(tool);
    if (!original || originalToShort.has(original)) continue;
    const base = shortenToolName(original);
    let candidate = base;
    for (let suffix = 1; used.has(candidate); suffix += 1) {
      const suffixText = `_${suffix}`;
      candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    }
    used.add(candidate);
    originalToShort.set(original, candidate);
    shortToOriginal.set(candidate, original);
  }

  return { originalToShort, shortToOriginal };
}

function translatedToolName(name: string, maps: ToolNameMaps): string {
  return maps.originalToShort.get(name) || shortenToolName(name);
}

function restoredToolName(name: string, maps: ToolNameMaps): string {
  return maps.shortToOriginal.get(name) || name;
}

function textPart(type: "input_text" | "output_text", text: string): JsonRecord {
  return { type, text };
}

function translateMessageContent(role: string, content: unknown): JsonRecord[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content ? [textPart(textType, content)] : [];
  }
  if (!Array.isArray(content)) return [];

  const translated: JsonRecord[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text")
      && typeof part.text === "string") {
      translated.push(textPart(textType, part.text));
      continue;
    }
    if ((part.type === "image_url" || part.type === "input_image") && role === "user") {
      const image = isRecord(part.image_url) ? part.image_url : undefined;
      const imageUrl = nonEmptyString(image?.url) || nonEmptyString(part.image_url);
      const fileId = nonEmptyString(part.file_id) || nonEmptyString(image?.file_id);
      if (!imageUrl && !fileId) continue;
      const output: JsonRecord = { type: "input_image" };
      if (imageUrl) output.image_url = imageUrl;
      if (fileId) output.file_id = fileId;
      const detail = nonEmptyString(part.detail) || nonEmptyString(image?.detail);
      if (detail) output.detail = detail;
      translated.push(output);
      continue;
    }
    if ((part.type === "file" || part.type === "input_file") && role === "user") {
      const file = isRecord(part.file) ? part.file : part;
      const fileId = nonEmptyString(file.file_id);
      const fileData = nonEmptyString(file.file_data);
      const fileUrl = nonEmptyString(file.file_url);
      if (!fileId && !fileData && !fileUrl) continue;
      const output: JsonRecord = { type: "input_file" };
      if (fileId) output.file_id = fileId;
      if (fileData) output.file_data = fileData;
      if (fileUrl) output.file_url = fileUrl;
      if (nonEmptyString(file.filename)) output.filename = file.filename;
      translated.push(output);
    }
  }
  return translated;
}

function toolOutputValue(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const translated = translateMessageContent("tool", content);
  return translated.length ? translated : JSON.stringify(content);
}

function translateMessages(messages: unknown[], maps: ToolNameMaps): JsonRecord[] {
  const input: JsonRecord[] = [];
  const priorCallTypes = new Map<string, "function" | "custom">();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message)) throw badRequest("invalid_messages", "Each chat message must be an object");
    const role = nonEmptyString(message.role);
    if (!role) throw badRequest("invalid_messages", "Each chat message requires a role");

    if (role === "tool") {
      const callId = nonEmptyString(message.tool_call_id);
      if (!callId) throw badRequest("invalid_tool_result", "Tool messages require tool_call_id");
      input.push({
        type: priorCallTypes.get(callId) === "custom" ? "custom_tool_call_output" : "function_call_output",
        call_id: callId,
        output: toolOutputValue(message.content),
      });
      continue;
    }

    if (!["system", "developer", "user", "assistant"].includes(role)) {
      throw badRequest("unsupported_message_role", `Unsupported chat message role: ${role}`);
    }

    const content = translateMessageContent(role, message.content);
    if (role !== "assistant" || content.length) {
      input.push({
        type: "message",
        role: role === "system" ? "developer" : role,
        content,
      });
    }

    if (role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (let toolIndex = 0; toolIndex < message.tool_calls.length; toolIndex += 1) {
      const call = message.tool_calls[toolIndex];
      if (!isRecord(call)) continue;
      const callType = call.type === "custom" ? "custom" : "function";
      const envelope = isRecord(callType === "custom" ? call.custom : call.function)
        ? callType === "custom" ? call.custom as JsonRecord : call.function as JsonRecord
        : undefined;
      if (!envelope) continue;
      const name = nonEmptyString(envelope.name);
      if (!name) continue;
      const callId = nonEmptyString(call.id) || `call_missing_${messageIndex}_${toolIndex}`;
      priorCallTypes.set(callId, callType);
      if (callType === "custom") {
        input.push({
          type: "custom_tool_call",
          call_id: callId,
          name: translatedToolName(name, maps),
          input: typeof envelope.input === "string" ? envelope.input : "",
        });
      } else {
        input.push({
          type: "function_call",
          call_id: callId,
          name: translatedToolName(name, maps),
          arguments: typeof envelope.arguments === "string" ? envelope.arguments : "{}",
        });
      }
    }
  }
  return input;
}

function translateTools(tools: unknown[], maps: ToolNameMaps): JsonRecord[] {
  const translated: JsonRecord[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) throw badRequest("invalid_tools", "Each tool must be an object");
    if (tool.type === "function") {
      if (!isRecord(tool.function)) throw badRequest("invalid_tools", "Function tools require a function object");
      const name = nonEmptyString(tool.function.name);
      if (!name) throw badRequest("invalid_tools", "Function tools require a name");
      const output: JsonRecord = {
        type: "function",
        name: translatedToolName(name, maps),
        parameters: isRecord(tool.function.parameters)
          ? tool.function.parameters
          : { type: "object", properties: {} },
      };
      if (typeof tool.function.description === "string") output.description = tool.function.description;
      if (typeof tool.function.strict === "boolean") output.strict = tool.function.strict;
      translated.push(output);
      continue;
    }
    if (tool.type === "custom" && isRecord(tool.custom)) {
      const name = nonEmptyString(tool.custom.name);
      if (!name) throw badRequest("invalid_tools", "Custom tools require a name");
      const output: JsonRecord = {
        type: "custom",
        name: translatedToolName(name, maps),
      };
      if (typeof tool.custom.description === "string") output.description = tool.custom.description;
      if (isRecord(tool.custom.format)) output.format = tool.custom.format;
      translated.push(output);
      continue;
    }
    // Responses built-ins and xAI Remote MCP already use a flat tool shape.
    translated.push(cloneRecord(tool));
  }
  return translated;
}

function translateToolChoice(value: unknown, maps: ToolNameMaps): unknown {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (value.type === "function" && isRecord(value.function)) {
    const name = nonEmptyString(value.function.name);
    return name ? { type: "function", name: translatedToolName(name, maps) } : undefined;
  }
  if (value.type === "custom" && isRecord(value.custom)) {
    const name = nonEmptyString(value.custom.name);
    return name ? { type: "custom", name: translatedToolName(name, maps) } : undefined;
  }
  return cloneRecord(value);
}

function translateResponseFormat(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" || value.type === "json_object") {
    return { format: { type: value.type } };
  }
  if (value.type !== "json_schema" || !isRecord(value.json_schema)) return undefined;
  const format: JsonRecord = { type: "json_schema" };
  if (typeof value.json_schema.name === "string") format.name = value.json_schema.name;
  if (typeof value.json_schema.strict === "boolean") format.strict = value.json_schema.strict;
  if (isRecord(value.json_schema.schema)) format.schema = value.json_schema.schema;
  return { format };
}

export function translateChatCompletionsPayload(raw: JsonObject): TranslatedChatPayload {
  const model = nonEmptyString(raw.model);
  if (!model) throw badRequest("missing_model", "The chat completions request requires a model");
  if (!Array.isArray(raw.messages)) {
    throw badRequest("missing_messages", "The chat completions request requires a messages array");
  }
  if (typeof raw.n === "number" && raw.n !== 1) {
    throw badRequest("unsupported_n", "Only n=1 is supported");
  }

  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  const toolNames = buildToolNameMaps(tools);
  const payload: JsonObject = {
    model,
    instructions: "",
    input: translateMessages(raw.messages, toolNames),
    stream: raw.stream === true,
    store: false,
  };

  if (tools.length) {
    payload.tools = translateTools(tools, toolNames);
    payload.parallel_tool_calls = typeof raw.parallel_tool_calls === "boolean" ? raw.parallel_tool_calls : true;
  }
  const toolChoice = translateToolChoice(raw.tool_choice, toolNames);
  if (toolChoice !== undefined && tools.length) payload.tool_choice = toolChoice;

  const maxOutputTokens = typeof raw.max_completion_tokens === "number"
    ? raw.max_completion_tokens
    : typeof raw.max_tokens === "number" ? raw.max_tokens : undefined;
  if (maxOutputTokens !== undefined) payload.max_output_tokens = maxOutputTokens;
  for (const field of ["temperature", "top_p", "top_k"] as const) {
    if (typeof raw[field] === "number") payload[field] = raw[field];
  }
  if (typeof raw.reasoning_effort === "string") payload.reasoning = { effort: raw.reasoning_effort };
  if (isRecord(raw.metadata)) payload.metadata = raw.metadata;
  if (typeof raw.user === "string") payload.user = raw.user;
  const text = translateResponseFormat(raw.response_format);
  if (text) payload.text = text;

  const includeUsage = isRecord(raw.stream_options) && raw.stream_options.include_usage === true;
  return { payload, clientStream: raw.stream === true, includeUsage, toolNames };
}

function usageFromResponse(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const completionTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
  const totalTokens = typeof value.total_tokens === "number"
    ? value.total_tokens
    : promptTokens + completionTokens;
  const usage: JsonRecord = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
  if (isRecord(value.input_tokens_details)) {
    usage.prompt_tokens_details = { ...value.input_tokens_details };
  }
  if (isRecord(value.output_tokens_details)) {
    usage.completion_tokens_details = { ...value.output_tokens_details };
  }
  return usage;
}

function responseIdentity(response: JsonRecord, context: ChatResponseContext): {
  id: string;
  created: number;
  model: string;
} {
  return {
    id: nonEmptyString(response.id) || `chatcmpl-${context.requestId}`,
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: nonEmptyString(response.model) || context.requestedModel,
  };
}

function incompleteFinishReason(response: JsonRecord): "length" | "content_filter" | "stop" {
  if (!isRecord(response.incomplete_details)) return "stop";
  const reason = response.incomplete_details.reason;
  if (reason === "max_tokens" || reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

export function chatCompletionFromResponse(value: unknown, context: ChatResponseContext): JsonObject {
  if (!isRecord(value)) throw new UpstreamError(502, "The upstream response was invalid");
  const identity = responseIdentity(value, context);
  let content = "";
  let reasoningContent = "";
  const toolCalls: JsonRecord[] = [];

  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      if (!isRecord(item)) continue;
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isRecord(part)) continue;
          if (part.type === "output_text" && typeof part.text === "string") content += part.text;
          if (part.type === "refusal" && typeof part.refusal === "string") content += part.refusal;
        }
      }
      if (item.type === "reasoning" && Array.isArray(item.summary)) {
        for (const summary of item.summary) {
          if (isRecord(summary) && summary.type === "summary_text" && typeof summary.text === "string") {
            reasoningContent += summary.text;
          }
        }
      }
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const name = nonEmptyString(item.name);
        const callId = nonEmptyString(item.call_id) || nonEmptyString(item.id);
        if (!name || !callId) continue;
        const argumentsValue = item.type === "custom_tool_call" ? item.input : item.arguments;
        toolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: restoredToolName(name, context.toolNames),
            arguments: typeof argumentsValue === "string" ? argumentsValue : "{}",
          },
        });
      }
    }
  }

  const message: JsonRecord = {
    role: "assistant",
    content: content || null,
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason = toolCalls.length
    ? "tool_calls"
    : value.status === "incomplete" ? incompleteFinishReason(value) : "stop";
  const response: JsonObject = {
    ...identity,
    object: "chat.completion",
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
  };
  const usage = usageFromResponse(value.usage);
  if (usage) response.usage = usage;
  return response;
}

function sseData(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function doneSse(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function chatChunk(identity: { id: string; created: number; model: string }, delta: JsonRecord, finishReason: string | null): JsonObject {
  return {
    ...identity,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

function eventObject(event: ParsedSseEvent): JsonRecord | null {
  if (event.data === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(event.data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    throw new UpstreamError(502, "The upstream response stream contained invalid data");
  }
}

export function chatCompletionStream(
  body: ReadableStream<Uint8Array> | null,
  context: ChatResponseContext,
): ReadableStream<Uint8Array> {
  if (!body) throw new UpstreamError(502, "The upstream response stream was empty");
  const fallbackIdentity = {
    id: `chatcmpl-${context.requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: context.requestedModel,
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let identity = fallbackIdentity;
      let terminal = false;
      let sawToolCall = false;
      let emittedText = false;
      let emittedReasoning = false;
      let toolIndex = -1;
      let currentTool: StreamToolState | undefined;
      const toolStates = new Map<string, StreamToolState>();
      const emittedToolCallIds = new Set<string>();

      const registerTool = (event: JsonRecord, item: JsonRecord, state: StreamToolState): void => {
        if (typeof event.item_id === "string") toolStates.set(`item:${event.item_id}`, state);
        if (typeof item.id === "string") toolStates.set(`item:${item.id}`, state);
        if (typeof event.output_index === "number") toolStates.set(`output:${event.output_index}`, state);
        currentTool = state;
      };
      const findTool = (event: JsonRecord, item?: JsonRecord): StreamToolState | undefined => {
        if (typeof event.item_id === "string") return toolStates.get(`item:${event.item_id}`);
        if (item && typeof item.id === "string") return toolStates.get(`item:${item.id}`);
        if (typeof event.output_index === "number") return toolStates.get(`output:${event.output_index}`);
        return currentTool;
      };
      const emit = (value: unknown): void => controller.enqueue(sseData(value));

      const consumeEvent = (event: ParsedSseEvent): void => {
        const object = eventObject(event);
        if (!object) return;
        const type = nonEmptyString(object.type) || event.eventName || "";

        if (type === "error") {
          emit({ error: { message: "The upstream response stream returned an error", type: "upstream_error", code: "upstream_error" } });
          controller.enqueue(doneSse());
          terminal = true;
          return;
        }
        if (type === "response.created" && isRecord(object.response)) {
          identity = responseIdentity(object.response, context);
          return;
        }
        if (type === "response.output_text.delta" && typeof object.delta === "string") {
          emittedText = true;
          emit(chatChunk(identity, { role: "assistant", content: object.delta }, null));
          return;
        }
        if (type === "response.reasoning_summary_text.delta" && typeof object.delta === "string") {
          emittedReasoning = true;
          emit(chatChunk(identity, { role: "assistant", reasoning_content: object.delta }, null));
          return;
        }
        if (type === "response.output_item.added" && isRecord(object.item)
          && (object.item.type === "function_call" || object.item.type === "custom_tool_call")) {
          toolIndex += 1;
          sawToolCall = true;
          const state: StreamToolState = { index: toolIndex, argumentsEmitted: false, done: false };
          registerTool(object, object.item, state);
          const callId = nonEmptyString(object.item.call_id) || nonEmptyString(object.item.id) || `call_${toolIndex}`;
          emittedToolCallIds.add(callId);
          const name = restoredToolName(nonEmptyString(object.item.name) || "tool", context.toolNames);
          emit(chatChunk(identity, {
            role: "assistant",
            tool_calls: [{ index: toolIndex, id: callId, type: "function", function: { name, arguments: "" } }],
          }, null));
          return;
        }
        if ((type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta")
          && typeof object.delta === "string") {
          const state = findTool(object);
          if (!state || state.done || !object.delta) return;
          state.argumentsEmitted = true;
          emit(chatChunk(identity, { tool_calls: [{ index: state.index, function: { arguments: object.delta } }] }, null));
          return;
        }
        if ((type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done")) {
          const state = findTool(object);
          if (!state || state.done || state.argumentsEmitted) return;
          const value = type === "response.custom_tool_call_input.done" ? object.input : object.arguments;
          if (typeof value !== "string" || !value) return;
          state.argumentsEmitted = true;
          emit(chatChunk(identity, { tool_calls: [{ index: state.index, function: { arguments: value } }] }, null));
          return;
        }
        if (type === "response.output_item.done" && isRecord(object.item)
          && (object.item.type === "function_call" || object.item.type === "custom_tool_call")) {
          let state = findTool(object, object.item);
          if (!state) {
            toolIndex += 1;
            sawToolCall = true;
            state = { index: toolIndex, argumentsEmitted: false, done: false };
            registerTool(object, object.item, state);
            const callId = nonEmptyString(object.item.call_id) || nonEmptyString(object.item.id) || `call_${toolIndex}`;
            emittedToolCallIds.add(callId);
            const name = restoredToolName(nonEmptyString(object.item.name) || "tool", context.toolNames);
            const args = object.item.type === "custom_tool_call" ? object.item.input : object.item.arguments;
            emit(chatChunk(identity, {
              role: "assistant",
              tool_calls: [{
                index: state.index,
                id: callId,
                type: "function",
                function: { name, arguments: typeof args === "string" ? args : "{}" },
              }],
            }, null));
            state.argumentsEmitted = true;
          } else if (!state.argumentsEmitted) {
            const args = object.item.type === "custom_tool_call" ? object.item.input : object.item.arguments;
            if (typeof args === "string" && args) {
              emit(chatChunk(identity, { tool_calls: [{ index: state.index, function: { arguments: args } }] }, null));
              state.argumentsEmitted = true;
            }
          }
          state.done = true;
          return;
        }
        if ((type === "response.completed" || type === "response.incomplete") && isRecord(object.response)) {
          identity = responseIdentity(object.response, context);
          if (Array.isArray(object.response.output)) {
            for (const item of object.response.output) {
              if (!isRecord(item)) continue;
              if (!emittedText && item.type === "message" && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (isRecord(part) && part.type === "output_text" && typeof part.text === "string" && part.text) {
                    emit(chatChunk(identity, { role: "assistant", content: part.text }, null));
                    emittedText = true;
                  }
                }
              }
              if (!emittedReasoning && item.type === "reasoning" && Array.isArray(item.summary)) {
                for (const summary of item.summary) {
                  if (isRecord(summary) && summary.type === "summary_text"
                    && typeof summary.text === "string" && summary.text) {
                    emit(chatChunk(identity, { role: "assistant", reasoning_content: summary.text }, null));
                    emittedReasoning = true;
                  }
                }
              }
              if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
              const callId = nonEmptyString(item.call_id) || nonEmptyString(item.id) || `call_${toolIndex + 1}`;
              if (emittedToolCallIds.has(callId)) continue;
              toolIndex += 1;
              sawToolCall = true;
              emittedToolCallIds.add(callId);
              const name = restoredToolName(nonEmptyString(item.name) || "tool", context.toolNames);
              const args = item.type === "custom_tool_call" ? item.input : item.arguments;
              emit(chatChunk(identity, {
                role: "assistant",
                tool_calls: [{
                  index: toolIndex,
                  id: callId,
                  type: "function",
                  function: { name, arguments: typeof args === "string" ? args : "{}" },
                }],
              }, null));
            }
          }
          const finishReason = sawToolCall
            ? "tool_calls"
            : object.response.status === "incomplete" ? incompleteFinishReason(object.response) : "stop";
          emit(chatChunk(identity, {}, finishReason));
          if (context.includeUsage) {
            emit({ ...identity, object: "chat.completion.chunk", choices: [], usage: usageFromResponse(object.response.usage) || null });
          }
          controller.enqueue(doneSse());
          terminal = true;
        }
      };

      const consumeBlock = (block: string): void => {
        if (terminal) return;
        const event = parseSseBlock(block);
        if (event) consumeEvent(event);
      };

      try {
        while (!terminal) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separatorIndex: number;
          while (!terminal && (separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const separator = buffer.match(/\r?\n\r?\n/)?.[0] || "\n\n";
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + separator.length);
            consumeBlock(block);
          }
        }
        buffer += decoder.decode();
        if (!terminal && buffer.trim()) consumeBlock(buffer);
        if (!terminal) {
          emit({ error: { message: "The upstream response did not complete", type: "upstream_error", code: "upstream_error" } });
          controller.enqueue(doneSse());
        }
      } catch {
        if (!terminal) {
          emit({ error: { message: "The upstream response stream was invalid", type: "upstream_error", code: "upstream_error" } });
          controller.enqueue(doneSse());
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

export async function handleChatCompletions(request: Request, env: Env, id: string): Promise<Response> {
  const raw = await readJsonObject(request, 2_000_000) as JsonObject;
  const translated = translateChatCompletionsPayload(raw);
  const normalized = normalizeResponsesPayload(translated.payload);
  const { credential } = await resolveCredential(env);
  const upstream = await fetchUpstream(env, credential, "/responses", {
    method: "POST",
    body: JSON.stringify(normalized.payload),
    accept: "text/event-stream",
    contentType: "application/json",
    conversationId: normalized.conversationId,
    kind: "text",
  });
  const context: ChatResponseContext = {
    requestedModel: String(normalized.payload.model),
    requestId: id,
    includeUsage: translated.includeUsage,
    toolNames: translated.toolNames,
  };

  if (translated.clientStream) {
    return new Response(chatCompletionStream(upstream.body, context), {
      status: 200,
      headers: streamingHeaders(id),
    });
  }
  const completed = await collectCompletedResponse(upstream.body);
  return jsonResponse(chatCompletionFromResponse(completed, context), 200, id);
}

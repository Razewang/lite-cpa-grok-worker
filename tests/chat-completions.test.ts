import { describe, expect, it } from "vitest";
import {
  chatCompletionFromResponse,
  chatCompletionStream,
  translateChatCompletionsPayload,
} from "../src/chat-completions";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Chat Completions adapter", () => {
  it("translates messages and function tools into Responses items", () => {
    const translated = translateChatCompletionsPayload({
      model: "grok/grok-4.5",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Weather?" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      max_completion_tokens: 512,
      stream: false,
    });

    expect(translated.clientStream).toBe(false);
    expect(translated.payload).toMatchObject({
      model: "grok/grok-4.5",
      instructions: "",
      stream: false,
      store: false,
      max_output_tokens: 512,
      parallel_tool_calls: true,
      tool_choice: { type: "function", name: "get_weather" },
      tools: [{
        type: "function",
        name: "get_weather",
        description: "Get weather",
      }],
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Be concise." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather?" }] },
      ],
    });
  });

  it("translates the assistant tool call and following MCP tool result", () => {
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [
        { role: "user", content: "Look it up" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_fixture",
            type: "function",
            function: { name: "mcp__docs__search", arguments: "{\"query\":\"xAI\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_fixture", content: "{\"result\":\"found\"}" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "mcp__docs__search",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      }],
    });

    expect(translated.payload.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Look it up" }] },
      {
        type: "function_call",
        call_id: "call_fixture",
        name: "mcp__docs__search",
        arguments: "{\"query\":\"xAI\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_fixture",
        output: "{\"result\":\"found\"}",
      },
    ]);
  });

  it("converts a completed function call into Chat Completions tool_calls", () => {
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{
        type: "function",
        function: { name: "get_weather", parameters: { type: "object", properties: {} } },
      }],
    });
    const result = chatCompletionFromResponse({
      id: "resp_fixture",
      model: "grok-4.5",
      created_at: 123,
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call_fixture",
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }, {
      requestedModel: "grok-4.5",
      requestId: "request-fixture",
      includeUsage: false,
      toolNames: translated.toolNames,
    });

    expect(result).toMatchObject({
      id: "resp_fixture",
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_fixture",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("shortens long MCP tool names upstream and restores them downstream", () => {
    const originalName = `mcp__large_server__${"very_long_tool_name_".repeat(4)}`;
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Use the tool" }],
      tools: [{
        type: "function",
        function: { name: originalName, parameters: { type: "object", properties: {} } },
      }],
    });
    const tools = translated.payload.tools as Array<Record<string, unknown>>;
    const shortName = String(tools[0].name);
    expect(shortName.length).toBeLessThanOrEqual(64);

    const response = chatCompletionFromResponse({
      status: "completed",
      output: [{ type: "function_call", call_id: "call_long", name: shortName, arguments: "{}" }],
    }, {
      requestedModel: "grok-4.5",
      requestId: "request-long",
      includeUsage: false,
      toolNames: translated.toolNames,
    });
    expect(response).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: originalName } }] } }],
    });
  });

  it("converts Responses text events into Chat Completions SSE", async () => {
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const source = streamFromText([
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"created_at\":123,\"model\":\"grok-4.5\"}}",
      "",
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"created_at\":123,\"model\":\"grok-4.5\",\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}}}",
      "",
      "",
    ].join("\n"));
    const output = await new Response(chatCompletionStream(source, {
      requestedModel: "grok-4.5",
      requestId: "request-stream",
      includeUsage: true,
      toolNames: translated.toolNames,
    })).text();

    expect(output).toContain('"object":"chat.completion.chunk"');
    expect(output).toContain('"content":"你好"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain('"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}');
    expect(output.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("streams function call identifiers, arguments, and a tool_calls finish reason", async () => {
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{
        type: "function",
        function: { name: "get_weather", parameters: { type: "object", properties: {} } },
      }],
      stream: true,
    });
    const source = streamFromText([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_tool\",\"created_at\":123,\"model\":\"grok-4.5\"}}",
      "",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"get_weather\"}}",
      "",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"fc_1\",\"delta\":\"{\\\"city\\\":\\\"Paris\\\"}\"}",
      "",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool\",\"created_at\":123,\"model\":\"grok-4.5\",\"status\":\"completed\"}}",
      "",
      "",
    ].join("\n"));
    const output = await new Response(chatCompletionStream(source, {
      requestedModel: "grok-4.5",
      requestId: "request-tool",
      includeUsage: false,
      toolNames: translated.toolNames,
    })).text();

    expect(output).toContain('"id":"call_1"');
    expect(output).toContain('"name":"get_weather"');
    expect(output).toContain('"arguments":"{\\\"city\\\":\\\"Paris\\\"}"');
    expect(output).toContain('"finish_reason":"tool_calls"');
  });

  it("falls back to tool calls carried only by response.completed", async () => {
    const translated = translateChatCompletionsPayload({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Use a tool" }],
      tools: [{
        type: "function",
        function: { name: "lookup", parameters: { type: "object", properties: {} } },
      }],
      stream: true,
    });
    const source = streamFromText([
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fallback\",\"model\":\"grok-4.5\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_fallback\",\"name\":\"lookup\",\"arguments\":\"{}\"}]}}",
      "",
      "",
    ].join("\n"));
    const output = await new Response(chatCompletionStream(source, {
      requestedModel: "grok-4.5",
      requestId: "request-fallback",
      includeUsage: false,
      toolNames: translated.toolNames,
    })).text();

    expect(output).toContain('"id":"call_fallback"');
    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"finish_reason":"tool_calls"');
  });
});

import { describe, expect, it } from "vitest";
import { collectCompletedResponse, normalizeResponsesPayload } from "../src/responses";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("Responses adapter", () => {
  it("cleans the client body and forces upstream SSE", () => {
    const normalized = normalizeResponsesPayload({
      model: "xai/grok-4-latest",
      instructions: null,
      input: "hello",
      prompt_cache_key: "conversation-1",
      previous_response_id: "remove-me",
      safety_identifier: "remove-me",
      generate: true,
      stream: false,
      tools: [{ type: "web_search" }],
    });
    expect(normalized.clientStream).toBe(false);
    expect(normalized.conversationId).toBe("conversation-1");
    expect(normalized.payload).toEqual({
      model: "grok-4",
      instructions: "",
      input: "hello",
      tools: [{ type: "web_search" }],
      stream: true,
    });
  });

  it("flattens Chat Completions tools sent to the Responses endpoint", () => {
    const normalized = normalizeResponsesPayload({
      model: "grok-4.5",
      input: "List my Stitch projects",
      tools: [
        {
          type: "function",
          function: {
            name: "mcp__stitch_mcp__list_projects",
            description: "List Stitch projects",
            parameters: {
              type: "object",
              properties: { filter: { type: "string" } },
              additionalProperties: false,
            },
            strict: true,
          },
        },
        { type: "web_search" },
      ],
      tool_choice: {
        type: "function",
        function: { name: "mcp__stitch_mcp__list_projects" },
      },
      stream: false,
    });

    expect(normalized.payload.tools).toEqual([
      {
        type: "function",
        name: "mcp__stitch_mcp__list_projects",
        description: "List Stitch projects",
        parameters: {
          type: "object",
          properties: { filter: { type: "string" } },
          additionalProperties: false,
        },
        strict: true,
      },
      { type: "web_search" },
    ]);
    expect(normalized.payload.tool_choice).toEqual({
      type: "function",
      name: "mcp__stitch_mcp__list_projects",
    });
  });

  it("keeps native Responses tools and tool choices unchanged", () => {
    const tools = [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
      { type: "x_search" },
    ];
    const toolChoice = { type: "function", name: "lookup" };
    const normalized = normalizeResponsesPayload({
      model: "grok-4.5",
      input: "Look it up",
      tools,
      tool_choice: toolChoice,
    });

    expect(normalized.payload.tools).toEqual(tools);
    expect(normalized.payload.tool_choice).toEqual(toolChoice);
  });

  it("supplies default parameters for nested functions and flattens custom tools", () => {
    const normalized = normalizeResponsesPayload({
      model: "grok-4.5",
      input: "Use a tool",
      tools: [
        { type: "function", function: { name: "no_arguments" } },
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a command",
            format: { type: "text" },
          },
        },
      ],
      tool_choice: { type: "custom", custom: { name: "shell" } },
    });

    expect(normalized.payload.tools).toEqual([
      {
        type: "function",
        name: "no_arguments",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "custom",
        name: "shell",
        description: "Run a command",
        format: { type: "text" },
      },
    ]);
    expect(normalized.payload.tool_choice).toEqual({ type: "custom", name: "shell" });
  });

  it("aggregates response.completed from chunked SSE", async () => {
    const body = streamFromChunks([
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"output\":[]}}\n\n",
      "data: [DONE]\n\n",
    ]);
    await expect(collectCompletedResponse(body)).resolves.toEqual({ id: "resp_fixture", output: [] });
  });

  it("keeps output_item.done entries when the completed event omits output", async () => {
    const body = streamFromChunks([
      "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_fixture\",\"name\":\"lookup\",\"arguments\":\"{}\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\",\"output\":[]}}\n\n",
    ]);
    await expect(collectCompletedResponse(body)).resolves.toMatchObject({
      id: "resp_fixture",
      output: [{ type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}" }],
    });
  });

  it("rejects an incomplete upstream stream", async () => {
    const body = streamFromChunks(["data: {\"type\":\"response.output_text.delta\"}\n\n"]);
    await expect(collectCompletedResponse(body)).rejects.toThrow("did not complete");
  });
});

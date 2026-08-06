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

  it("aggregates response.completed from chunked SSE", async () => {
    const body = streamFromChunks([
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"output\":[]}}\n\n",
      "data: [DONE]\n\n",
    ]);
    await expect(collectCompletedResponse(body)).resolves.toEqual({ id: "resp_fixture", output: [] });
  });

  it("rejects an incomplete upstream stream", async () => {
    const body = streamFromChunks(["data: {\"type\":\"response.output_text.delta\"}\n\n"]);
    await expect(collectCompletedResponse(body)).rejects.toThrow("did not complete");
  });
});


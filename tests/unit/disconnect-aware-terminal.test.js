// Regression guard for the terminal-event delivery invariant on the Responses
// wire: whatever emits response.completed must do so DURING transform — the
// disconnect-aware wrapper drops transform-flush output when the controller
// reports disconnected at upstream end (the deferral regression of 2026-09-12,
// which surfaced as "stream closed before response.completed" on the wire).
import { describe, it, expect } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { formatIncompleteOpenAIResponsesStreamFailure } from "../../open-sse/utils/responsesStreamHelpers.js";

const abortTerminalBytes = () => new TextEncoder().encode(formatIncompleteOpenAIResponsesStreamFailure());

function fakeStreamController() {
  let connected = true;
  return {
    disconnect() { connected = false; },
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    handleError: () => {},
    signal: undefined,
    startTime: Date.now(),
    abort: () => {},
  };
}

const COMPLETED_EVENT = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", status: "completed", output: [] },
})}\n\n`;

// Transform variants over a trivial line protocol:
//   {"kind":"emit"}       — enqueue the terminal during transform
//   {"kind":"defer"}      — hold it for flush
//   {"kind":"disconnect"} — flip the stream controller to disconnected
function makeTransform(variant, onDisconnect) {
  return new TransformStream({
    transform(chunk, controller) {
      const message = JSON.parse(new TextDecoder().decode(chunk));
      if (message.kind === "emit") controller.enqueue(new TextEncoder().encode(COMPLETED_EVENT));
      if (message.kind === "disconnect") onDisconnect();
    },
    flush(controller) {
      if (variant === "defer") controller.enqueue(new TextEncoder().encode(COMPLETED_EVENT));
    },
  });
}

// Provider script for each variant:
//   emit:    chunk1 emits the terminal (read+forwarded), chunk2 flips the
//            controller, then close — the delivered terminal must survive.
//   defer:   the controller flips BEFORE any terminal exists in the queue, the
//            provider closes, and the flush runs while disconnected — the
//            deferred terminal is dropped (the documented race).
function providerStream(variant, onDisconnect) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      if (variant === "emit") {
        controller.enqueue(encoder.encode(JSON.stringify({ kind: "emit" }) + "\n"));
        controller.enqueue(encoder.encode(JSON.stringify({ kind: "disconnect" }) + "\n"));
      } else {
        onDisconnect();
        controller.enqueue(encoder.encode(JSON.stringify({ kind: "noop" }) + "\n"));
      }
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

function runPipeline(variant) {
  const streamController = fakeStreamController();
  const provider = { body: providerStream(variant, () => streamController.disconnect()) };
  const composed = pipeWithDisconnect(
    provider,
    makeTransform(variant, () => streamController.disconnect()),
    streamController,
    abortTerminalBytes,
  );
  return drain(composed);
}

describe("disconnect-aware terminal delivery (Responses wire invariant)", () => {
  it("delivers a transform-time response.completed even when the controller disconnects afterwards", async () => {
    const output = await runPipeline("emit");
    expect(output).toContain("event: response.completed");
  });

  it("drops a flush-deferred terminal when disconnected before flush (documents the race)", async () => {
    const output = await runPipeline("defer");
    // The invariant under test: a flush-deferred terminal is NOT guaranteed to
    // reach the client when the controller disconnects before the flush runs.
    // (Whether the abort terminal is synthesized depends on pull timing.)
    expect(output).not.toContain("event: response.completed");
  });
});

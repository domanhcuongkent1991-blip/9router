import { handleChat } from "@/sse/handlers/chat.js";
import { createResponsesHandler } from "open-sse/compat/responses/handler.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const handleResponsesRequest = createResponsesHandler({
  initialize: ensureInitialized,
  dispatch: handleChat,
});

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  return handleResponsesRequest(request);
}

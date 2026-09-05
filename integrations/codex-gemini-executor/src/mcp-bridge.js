import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const decisionSchema = z.enum(["accept", "decline", "cancel"]);
const jobIdSchema = z.string().min(1).max(512);
const statusSchema = z.enum(["starting", "running", "awaiting_approval", "completed", "failed", "cancelled"]);
const resultSchema = z.object({
  jobId: jobIdSchema,
  status: statusSchema,
  sessionId: z.string().max(512).optional(),
  workspace: z.string().max(4096).optional(),
  worktreePath: z.string().max(4096).nullable().optional(),
  revision: z.number().int().nonnegative().optional(),
  updatedAt: z.string().max(128).optional(),
  finalAnswer: z.string().max(65_536).optional(),
  filesChanged: z.array(z.string().max(4096)).max(1024).optional(),
  tests: z.array(z.union([z.string().max(16_384), z.record(z.string(), z.unknown())])).max(256).optional(),
  output: z.string().max(32_768).optional(),
  access: z.enum(["read-only", "workspace-write"]).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  compatibilityWarnings: z.array(z.object({ code: z.string().max(128) }).passthrough()).max(16).optional(),
  approval: z.object({
    type: z.enum(["command", "file_change"]),
    jobId: jobIdSchema,
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    itemId: z.string().min(1).max(512),
    command: z.string().max(65_536).nullable().optional(),
    cwd: z.string().max(4096).nullable().optional(),
    reason: z.string().max(16_384).nullable().optional(),
    decisions: z.tuple([z.literal("accept"), z.literal("decline"), z.literal("cancel")]),
  }).strict().optional(),
  error: z.object({ category: z.string().max(128) }).passthrough().optional(),
}).strict();

function toolResult(value) {
  const parsed = resultSchema.parse(value);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    structuredContent: parsed,
    isError: parsed.status === "failed",
  };
}

function createDecisionProvider(context) {
  return async (approval) => {
    if (typeof context?.mcpReq?.elicitInput !== "function") throw new Error("elicitation_unavailable");
    const detail = approval.type === "file_change"
      ? `File change requested. Reason: ${approval.reason ?? "not provided"}`
      : `Command: ${approval.command ?? "not provided"}\nDirectory: ${approval.cwd ?? "not provided"}\nReason: ${approval.reason ?? "not provided"}`;
    const message = Buffer.from(detail, "utf8").subarray(0, 16 * 1024).toString("utf8").replace(/�$/u, "");
    const response = await context.mcpReq.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["accept", "decline", "cancel"] } },
        required: ["decision"],
        additionalProperties: false,
      },
    });
    if (response?.action === "decline") return "decline";
    if (response?.action === "cancel") return "cancel";
    const parsed = decisionSchema.safeParse(response?.content?.decision);
    if (response?.action !== "accept" || !parsed.success) throw new Error("elicitation_mismatch");
    return parsed.data;
  };
}

export function createGeminiMcpServer({ core, ServerClass = McpServer }) {
  if (!core || typeof core.runGeminiTask !== "function" || typeof core.getGeminiStatus !== "function"
    || typeof core.cancelGeminiTask !== "function") throw new TypeError("A Gemini companion core is required");
  const server = new ServerClass(
    { name: "9router-gemini-executor", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool("run_gemini_task", {
    title: "Run Gemini task",
    description: "Run a bounded Gemini-backed Codex task in an approved workspace.",
    inputSchema: z.object({
      task: z.string().trim().min(1).max(65_536),
      workspace: z.string().min(3).max(4096),
      effort: z.enum(["low", "medium", "high"]).optional(),
      access: z.enum(["read-only", "workspace-write"]).optional(),
      session_id: z.string().min(1).max(512).optional(),
      timeout_minutes: z.number().int().min(1).max(120).optional(),
    }).strict(),
    outputSchema: resultSchema,
  }, async (request, context) => toolResult(await core.runGeminiTask(request, {
    onStarted: async (jobId) => {
      if (typeof context?.mcpReq?.notify === "function") {
        const progressToken = context.mcpReq?._meta?.progressToken;
        await context.mcpReq.notify(progressToken === undefined
          ? { method: "notifications/message", params: { level: "info", logger: "9router-gemini-executor", data: { jobId } } }
          : { method: "notifications/progress", params: { progressToken, progress: 0, total: 1, message: `jobId=${jobId}` } });
      }
    },
    requestDecision: createDecisionProvider(context),
  })));

  const idInput = z.object({ job_id: jobIdSchema }).strict();
  server.registerTool("get_gemini_status", {
    title: "Get Gemini job status", inputSchema: idInput, outputSchema: resultSchema,
    annotations: { readOnlyHint: true },
  }, async ({ job_id: jobId }) => toolResult(core.getGeminiStatus(jobId)));
  server.registerTool("cancel_gemini_task", {
    title: "Cancel Gemini job", inputSchema: idInput, outputSchema: resultSchema,
  }, async ({ job_id: jobId }) => toolResult(await core.cancelGeminiTask(jobId)));

  return server;
}

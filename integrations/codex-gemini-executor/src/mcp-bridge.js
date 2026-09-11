import { createHash, randomUUID } from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  PUBLIC_ERROR_CATEGORIES,
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_FIELDS,
  PUBLIC_ERROR_REASONS,
  PUBLIC_ERROR_SOURCES,
  PUBLIC_ERROR_STAGES,
  classifyCompanionError,
  normalizePublicError,
} from "./error-classification.js";

const decisionSchema = z.enum(["accept", "decline", "cancel"]);
const decisionObjectSchema = z.object({ decision: decisionSchema }).strict();
const jobIdSchema = z.string().min(1).max(512);
const statusSchema = z.enum(["starting", "running", "awaiting_approval", "completed", "failed", "cancelled"]);
const errorSchema = z.object({
  category: z.enum(PUBLIC_ERROR_CATEGORIES),
  source: z.enum(PUBLIC_ERROR_SOURCES),
  code: z.enum(PUBLIC_ERROR_CODES).optional(),
  status: z.number().int().min(100).max(599).optional(),
  stage: z.enum(PUBLIC_ERROR_STAGES).optional(),
  reason: z.enum(PUBLIC_ERROR_REASONS).optional(),
  field: z.enum(PUBLIC_ERROR_FIELDS).optional(),
}).strict();
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
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u).optional(),
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
  error: errorSchema.optional(),
}).strict();

function toolResult(value) {
  const normalized = value !== null && typeof value === "object" && Object.hasOwn(value, "error")
    ? { ...value, error: normalizePublicError(value.error) }
    : value;
  const parsed = resultSchema.parse(normalized);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    structuredContent: parsed,
    isError: parsed.status === "failed",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function requestFingerprint(request, modelPolicy) {
  const model = modelPolicy?.allowedModels?.includes(request.model ?? modelPolicy.defaultModel)
    ? request.model ?? modelPolicy.defaultModel
    : request.model ?? null;
  return createHash("sha256").update(JSON.stringify([
    request.task,
    request.workspace,
    request.effort ?? "medium",
    request.access ?? "read-only",
    model,
    request.session_id ?? null,
    request.timeout_minutes ?? 30,
  ])).digest("hex");
}

function approvalMessage(approval) {
  const detail = approval.type === "file_change"
    ? `File change requested. Reason: ${approval.reason ?? "not provided"}`
    : `Command: ${approval.command ?? "not provided"}\nDirectory: ${approval.cwd ?? "not provided"}\nReason: ${approval.reason ?? "not provided"}`;
  return Buffer.from(detail, "utf8").subarray(0, 16 * 1024).toString("utf8").replace(/�$/u, "");
}

function stateFrom(context) {
  try {
    const request = context?.mcpReq;
    const state = typeof request?.requestState === "function" ? request.requestState() : undefined;
    if (state === undefined && (request?.inputResponses !== undefined || request?.droppedInputResponseKeys !== undefined)) {
      throw new Error("invalid_approval_correlation");
    }
    return state;
  } catch {
    throw new Error("invalid_approval_correlation");
  }
}

export function createGeminiMcpServer({ core, ServerClass = McpServer, generateCorrelationId = randomUUID }) {
  if (!core || typeof core.runGeminiTask !== "function" || typeof core.getGeminiStatus !== "function"
    || typeof core.cancelGeminiTask !== "function") throw new TypeError("A Gemini companion core is required");
  if (typeof generateCorrelationId !== "function") throw new TypeError("A correlation ID generator is required");
  const pendingByToken = new Map();
  const pendingByJob = new Map();
  const activeRuns = new Set();

  function cleanupPending(pending) {
    if (pending.cleaned) return;
    pending.cleaned = true;
    activeRuns.delete(pending);
    for (const token of pending.tokens) pendingByToken.delete(token);
    pending.tokens.clear();
    if (pending.jobId) pendingByJob.delete(pending.jobId);
    pending.currentApproval?.decision.resolve("cancel");
    pending.currentApproval = null;
  }

  function mintToken(pending) {
    const token = generateCorrelationId();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(token) || pendingByToken.has(token)) {
      throw new Error("invalid_approval_correlation");
    }
    pending.tokens.add(token);
    pendingByToken.set(token, pending);
    return token;
  }

  async function progress(context, jobId) {
    if (typeof context?.mcpReq?.notify !== "function") return;
    const progressToken = context.mcpReq?._meta?.progressToken;
    try {
      await context.mcpReq.notify(progressToken === undefined
        ? { method: "notifications/message", params: { level: "info", logger: "9router-gemini-executor", data: { jobId } } }
        : { method: "notifications/progress", params: { progressToken, progress: 0, total: 1, message: `jobId=${jobId}` } });
    } catch {
      // Progress is advisory; the job remains queryable by its returned correlation flow.
    }
  }

  function startRun(request, context) {
    const pending = {
      fingerprint: requestFingerprint(request, core.modelPolicy),
      jobId: null,
      tokens: new Set(),
      currentApproval: null,
      approvalReady: deferred(),
      approvalCount: 0,
      cleaned: false,
      completion: null,
    };
    activeRuns.add(pending);
    pending.completion = Promise.resolve(core.runGeminiTask(request, {
      signal: context?.signal ?? context?.mcpReq?.signal,
      onStarted: async (jobId) => {
        pending.jobId = jobId;
        pendingByJob.set(jobId, pending);
        await progress(context, jobId);
      },
      requestDecision: (approval) => {
        if (pending.cleaned || pending.currentApproval || ++pending.approvalCount > 256) {
          return Promise.reject(new Error("invalid_approval_sequence"));
        }
        const decision = deferred();
        pending.currentApproval = { approval, decision };
        pending.approvalReady.resolve();
        return decision.promise;
      },
    })).then(
      (result) => ({ type: "terminal", result }),
      (error) => ({ type: "terminal", result: {
        jobId: pending.jobId ?? "job_unavailable", status: "failed", error: classifyCompanionError(error),
      } }),
    );
    pending.completion.then(() => cleanupPending(pending));
    return pending;
  }

  async function waitForOutcome(pending) {
    if (pending.currentApproval) return { type: "approval" };
    return Promise.race([
      pending.completion,
      pending.approvalReady.promise.then(() => ({ type: "approval" })),
    ]);
  }

  async function failPending(pending) {
    const jobId = pending.jobId ?? "job_unavailable";
    const current = pending.currentApproval;
    pending.currentApproval = null;
    pending.approvalReady = deferred();
    current?.decision.resolve("cancel");
    if (pending.jobId) {
      try { await core.cancelGeminiTask(pending.jobId); } catch { /* fail closed below */ }
    }
    await pending.completion;
    cleanupPending(pending);
    return toolResult({ jobId, status: "failed", error: { category: "protocol_error" } });
  }

  function supportsFormElicitation(context) {
    const declared = context?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]
      ?? server.server?.getClientCapabilities?.();
    if (declared === undefined && !server.server) return true;
    const elicitation = declared?.elicitation;
    if (elicitation === null || typeof elicitation !== "object" || Array.isArray(elicitation)) return false;
    const modes = Object.keys(elicitation);
    return modes.length === 0 || (elicitation.form !== null && typeof elicitation.form === "object");
  }

  async function continueRun(request, context) {
    const state = stateFrom(context);
    let pending;
    if (state === undefined) {
      pending = startRun(request, context);
    } else {
      if (typeof state !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(state)) throw new Error("invalid_approval_correlation");
      pending = pendingByToken.get(state);
      if (!pending) throw new Error("invalid_approval_correlation");
      pendingByToken.delete(state);
      pending.tokens.delete(state);
      if (pending.fingerprint !== requestFingerprint(request, core.modelPolicy) || !pending.currentApproval) return failPending(pending);

      const response = inputResponse(context?.mcpReq?.inputResponses, "approval");
      let decision;
      if (response.kind === "elicit" && response.action === "decline") decision = "decline";
      else if (response.kind === "elicit" && response.action === "cancel") decision = "cancel";
      else if (response.kind === "elicit" && response.action === "accept") {
        decision = acceptedContent(context?.mcpReq?.inputResponses, "approval", decisionObjectSchema)?.decision;
      }
      if (!decisionSchema.safeParse(decision).success) return failPending(pending);
      const current = pending.currentApproval;
      pending.currentApproval = null;
      pending.approvalReady = deferred();
      current.decision.resolve(decision);
    }

    const outcome = await waitForOutcome(pending);
    if (outcome.type === "terminal") {
      cleanupPending(pending);
      return toolResult(outcome.result);
    }
    if (!supportsFormElicitation(context)) return failPending(pending);
    let token;
    try { token = mintToken(pending); } catch { return failPending(pending); }
    return inputRequired({
      inputRequests: {
        approval: inputRequired.elicit({
          message: approvalMessage(pending.currentApproval.approval),
          requestedSchema: {
            type: "object",
            properties: { decision: { type: "string", enum: ["accept", "decline", "cancel"] } },
            required: ["decision"],
            additionalProperties: false,
          },
        }),
      },
      requestState: token,
    });
  }

  const server = new ServerClass(
    { name: "9router-gemini-executor", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      requestState: {
        verify: async (state) => {
          if (typeof state !== "string" || !pendingByToken.has(state)) throw new Error("invalid state");
          return state;
        },
      },
    },
  );

  if (server.server) {
    server.server.onclose = () => {
      for (const pending of [...activeRuns]) void failPending(pending);
    };
  }

  server.registerTool("run_gemini_task", {
    title: "Run Gemini task",
    description: "Run a bounded Gemini-backed Codex task in an approved workspace.",
    inputSchema: z.object({
      task: z.string().trim().min(1).max(65_536),
      workspace: z.string().min(3).max(4096),
      effort: z.enum(["low", "medium", "high"]).optional(),
      access: z.enum(["read-only", "workspace-write"]).optional(),
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u).optional(),
      session_id: z.string().min(1).max(512).optional(),
      timeout_minutes: z.number().int().min(1).max(120).optional(),
    }).strict(),
    outputSchema: resultSchema,
  }, continueRun);

  const idInput = z.object({ job_id: jobIdSchema }).strict();
  server.registerTool("get_gemini_status", {
    title: "Get Gemini job status", inputSchema: idInput, outputSchema: resultSchema,
    annotations: { readOnlyHint: true },
  }, async ({ job_id: jobId }) => toolResult(await core.getGeminiStatus(jobId)));
  server.registerTool("cancel_gemini_task", {
    title: "Cancel Gemini job", inputSchema: idInput, outputSchema: resultSchema,
  }, async ({ job_id: jobId }) => {
    const pending = pendingByJob.get(jobId);
    pending?.currentApproval?.decision.resolve("cancel");
    const result = await core.cancelGeminiTask(jobId);
    if (pending) cleanupPending(pending);
    return toolResult(result);
  });

  return server;
}

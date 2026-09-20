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
const jobIdSchema = z.string().min(1).max(512);
const scopePathSchema = z.string().min(1).max(4096);
const publicScopeSchema = z.object({
  read: z.array(scopePathSchema).min(1).max(32),
  write: z.array(scopePathSchema).max(32),
  allow_create: z.boolean().optional(),
}).strict();
const runInputSchema = z.object({
  task: z.string().trim().min(1).max(65_536),
  workspace: z.string().min(3).max(4096),
  effort: z.enum(["low", "medium", "high"]).optional(),
  access: z.enum(["read-only", "workspace-write"]).optional(),
  scope: publicScopeSchema.optional(),
  session_id: z.string().min(1).max(512).optional(),
  timeout_minutes: z.number().int().min(1).max(120).optional(),
}).strict();
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
  recoveryRequired: z.boolean().optional(),
  recoveryId: z.string().max(512).optional(),
  recoverySources: z.array(z.enum(["journal", "cleanup", "unknown"])).max(3).optional(),
  recoveryOperationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)).max(16).optional(),
  tests: z.array(z.union([z.string().max(16_384), z.record(z.string(), z.unknown())])).max(256).optional(),
  output: z.string().max(32_768).optional(),
  access: z.enum(["read-only", "workspace-write"]).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u).optional(),
  compatibilityWarnings: z.array(z.object({ code: z.string().max(128) }).passthrough()).max(16).optional(),
  approval: z.union([
    z.object({
      type: z.enum(["command", "file_change"]),
      jobId: jobIdSchema,
      threadId: z.string().min(1).max(512),
      turnId: z.string().min(1).max(512),
      itemId: z.string().min(1).max(512),
      command: z.string().max(65_536).nullable().optional(),
      cwd: z.string().max(4096).nullable().optional(),
      reason: z.string().max(16_384).nullable().optional(),
      decisions: z.tuple([z.literal("accept"), z.literal("decline"), z.literal("cancel")]),
    }).strict(),
    z.object({
      type: z.literal("job_scope"),
      workspace: z.string().min(1).max(4096),
      access: z.enum(["read-only", "workspace-write"]),
      scope: publicScopeSchema,
      deadline: z.number().finite().optional(),
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u).optional(),
    }).strict(),
    z.object({
      type: z.literal("write_intent"),
      operation: z.enum(["replace_text", "create_text"]),
      path: z.string().min(1).max(4096),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      allowCreate: z.literal(true).optional(),
      operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      deadline: z.number().finite().optional(),
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/u).optional(),
    }).strict(),
  ]).optional(),
  error: errorSchema.optional(),
}).strict();

function toolResult(value) {
  const normalized = value !== null && typeof value === "object"
    ? { ...value,
      ...(Object.hasOwn(value, "error") ? { error: normalizePublicError(value.error) } : {}),
      ...(value.access === "scoped-edit" ? { access: "workspace-write" } : {}),
    }
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

function canonicalScope(scope) {
  if (scope === undefined) return null;
  return {
    read: [...scope.read].sort((left, right) => left.localeCompare(right, "en")),
    write: [...scope.write].sort((left, right) => left.localeCompare(right, "en")),
    allow_create: scope.allow_create ?? false,
  };
}

function requestFingerprint(request) {
  return createHash("sha256").update(JSON.stringify([
    request.task,
    request.workspace,
    request.effort ?? "medium",
    request.access ?? "read-only",
    canonicalScope(request.scope),
    request.session_id ?? null,
    request.timeout_minutes ?? 30,
  ])).digest("hex");
}

function approvalForDisplay(approval, model) {
  if (approval?.type === "write_intent") {
    return {
      type: "write_intent",
      operation: approval.operation,
      path: approval.path,
      ...(approval.expectedSha256 === undefined ? {} : { expectedSha256: approval.expectedSha256 }),
      ...(approval.allowCreate === true ? { allowCreate: true } : {}),
      operationFingerprint: approval.operationFingerprint,
      ...(approval.deadline === undefined ? {} : { deadline: approval.deadline }),
      ...(typeof model === "string" ? { model } : {}),
    };
  }
  if (approval?.type === "job_scope") {
    return {
      type: "job_scope",
      workspace: approval.workspace,
      access: approval.access,
      scope: canonicalScope(approval.scope),
      ...(approval.deadline === undefined ? {} : { deadline: approval.deadline }),
      ...(typeof model === "string" ? { model } : {}),
    };
  }
  return approval;
}

function approvalMessage(approval) {
  const detail = approval.type === "write_intent"
    ? `Write intent: ${approval.operation}\nPath: ${approval.path}${approval.expectedSha256 ? `\nExpected SHA-256: ${approval.expectedSha256}` : ""}${approval.allowCreate ? "\nCreate allowed: true" : ""}${approval.deadline ? `\nDeadline: ${approval.deadline}` : ""}${approval.model ? `\nModel: ${approval.model}` : ""}`
    : approval.type === "job_scope"
      ? `Scoped job: ${approval.access}\nWorkspace: ${approval.workspace}${approval.deadline ? `\nDeadline: ${approval.deadline}` : ""}${approval.model ? `\nModel: ${approval.model}` : ""}`
      : approval.type === "file_change"
        ? `File change requested. Reason: ${approval.reason ?? "not provided"}`
        : `Command: ${approval.command ?? "not provided"}\nDirectory: ${approval.cwd ?? "not provided"}\nReason: ${approval.reason ?? "not provided"}`;
  return Buffer.from(detail, "utf8").subarray(0, 16 * 1024).toString("utf8").replace(/�$/u, "");
}

// Structured approval facts ride in the requested schema as a read-only const
// property so clients can decide from the same parsed command Codex will run
// instead of parsing the display message. Not required: legacy clients that
// only answer {decision} stay valid.
function commandApprovalSchema(approval) {
  return {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["accept", "decline", "cancel"] },
      commandActions: { type: "string", const: approvalFacts(approval) },
    },
    required: ["decision"],
    additionalProperties: false,
  };
}

function approvalFacts(approval) {
  return JSON.stringify(approval?.type === "write_intent" || approval?.type === "job_scope"
    ? approval : approval?.commandActions ?? null);
}

// A conforming form client may return the optional const field it was shown.
// Accept that exact value or its omission, never caller-modified facts or extras.
function decisionObjectSchema(approval) {
  return z.object({ decision: decisionSchema,
    commandActions: z.literal(approvalFacts(approval)).optional(),
  }).strict();
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

export function createGeminiMcpServer({ core, ServerClass = McpServer, generateCorrelationId = randomUUID,
  onApprovalTrace = () => {} }) {
  if (!core || typeof core.runGeminiTask !== "function" || typeof core.getGeminiStatus !== "function"
    || typeof core.cancelGeminiTask !== "function") throw new TypeError("A Gemini companion core is required");
  if (typeof generateCorrelationId !== "function") throw new TypeError("A correlation ID generator is required");
  if (typeof onApprovalTrace !== "function") throw new TypeError("Approval trace must be a function");
  const pendingByToken = new Map();
  const pendingByJob = new Map();
  const activeRuns = new Set();

  function trace(event, pending, facts = {}) {
    // Caller payloads, approval facts/text and continuation tokens never enter
    // diagnostics. Observer failures cannot authorize or resume a job.
    try {
      Promise.resolve(onApprovalTrace(Object.freeze({ event, at: new Date().toISOString(),
        ...(pending?.jobId ? { jobId: pending.jobId } : {}), ...facts }))).catch(() => {});
    } catch { /* diagnostics cannot alter execution */ }
  }

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
      fingerprint: requestFingerprint(request),
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
        const display = approvalForDisplay(approval, core.modelPolicy?.defaultModel);
        const decision = deferred();
        pending.currentApproval = { approval: display, decision };
        trace("approval_requested", pending);
        pending.approvalReady.resolve();
        return decision.promise;
      },
    })).then(
      (result) => ({ type: "terminal", result }),
      (error) => ({ type: "terminal", result: {
        jobId: pending.jobId ?? "job_unavailable", status: "failed", error: classifyCompanionError(error),
      } }),
    );
    pending.completion.then(() => { trace("job_terminal", pending); cleanupPending(pending); });
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

  async function continueRun(rawRequest, context) {
    const parsedRequest = runInputSchema.safeParse(rawRequest);
    if (!parsedRequest.success) {
      const state = stateFrom(context);
      if (typeof state === "string" && pendingByToken.has(state)) return failPending(pendingByToken.get(state));
      throw new Error("invalid_request");
    }
    const request = parsedRequest.data;
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
      trace("continuation_received", pending);
      if (pending.fingerprint !== requestFingerprint(request) || !pending.currentApproval) return failPending(pending);

      const response = inputResponse(context?.mcpReq?.inputResponses, "approval");
      let decision;
      if (response.kind === "elicit" && response.action === "decline") decision = "decline";
      else if (response.kind === "elicit" && response.action === "cancel") decision = "cancel";
      else if (response.kind === "elicit" && response.action === "accept") {
        decision = acceptedContent(context?.mcpReq?.inputResponses, "approval", decisionObjectSchema(pending.currentApproval.approval))?.decision;
      }
      if (!decisionSchema.safeParse(decision).success) {
        trace("decision_rejected", pending);
        return failPending(pending);
      }
      trace("decision_received", pending, { decision });
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
          requestedSchema: commandApprovalSchema(pending.currentApproval.approval),
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
        verify: async (state, context) => {
          const response = inputResponse(context?.mcpReq?.inputResponses, "approval");
          const facts = response.kind === "elicit" && decisionSchema.safeParse(response.action).success
            ? { action: response.action } : {};
          if (typeof state !== "string" || !pendingByToken.has(state)) {
            trace("state_rejected", null, facts);
            throw new Error("invalid state");
          }
          trace("state_verified", pendingByToken.get(state), facts);
          return state;
        },
      },
    },
  );

  if (server.server) {
    server.server.onclose = () => {
      trace("channel_closed");
      for (const pending of [...activeRuns]) void failPending(pending);
    };
  }

  server.registerTool("run_gemini_task", {
    title: "Run Gemini task",
    description: "Run a bounded Gemini-backed Codex task in an approved workspace.",
    inputSchema: runInputSchema,
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

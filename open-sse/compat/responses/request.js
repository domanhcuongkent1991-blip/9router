import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

const MAX_CALL_ID_LENGTH = 64;
const MAX_INPUT_ITEMS = 2_048;
const MAX_CONTENT_PARTS = 8_192;
const MAX_DECLARED_TOOLS = 128;

const SUPPORTED_INPUT_ITEM_TYPES = new Set([
  RESPONSES_ITEM.MESSAGE,
  RESPONSES_ITEM.REASONING,
  RESPONSES_ITEM.FUNCTION_CALL,
  RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT,
  RESPONSES_ITEM.ADDITIONAL_TOOLS,
]);
const SUPPORTED_MESSAGE_ROLES = new Set([
  ROLE.USER,
  ROLE.ASSISTANT,
  ROLE.SYSTEM,
  ROLE.DEVELOPER,
]);
const SUPPORTED_CONTENT_TYPES = new Set([
  RESPONSES_ITEM.INPUT_TEXT,
  RESPONSES_ITEM.OUTPUT_TEXT,
  RESPONSES_ITEM.INPUT_IMAGE,
]);
const SUPPORTED_TOOL_TYPES = new Set(["function", "custom"]);
const SUPPORTED_STRING_TOOL_CHOICES = new Set(["auto", "none", "required"]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pass = (value) => ({ ok: true, value });
const fail = (message, param, code = "invalid_value") => ({
  ok: false,
  error: { message, param, code },
});

function stringifyWireValue(value, fallback) {
  if (typeof value === "string") return value;
  return JSON.stringify(value === undefined ? fallback : value);
}

function isPortableImageUrl(value) {
  if (typeof value !== "string") return false;

  if (value.startsWith("data:")) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/i.exec(value);
    return Boolean(match && match[1].length % 4 === 0);
  }

  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function addContentParts(state, count, path) {
  if (state.contentPartCount + count > MAX_CONTENT_PARTS) {
    return fail(
      `Responses requests support at most ${MAX_CONTENT_PARTS} content parts.`,
      path,
      "limit_exceeded",
    );
  }
  state.contentPartCount += count;
  return null;
}

function normalizeCallId(callId, path, state) {
  if (typeof callId !== "string" || callId.trim() === "") {
    return fail("Tool calls and outputs require a non-empty call_id.", path);
  }

  const clamped = callId.length > MAX_CALL_ID_LENGTH
    ? callId.slice(0, MAX_CALL_ID_LENGTH)
    : callId;
  if (state.callIdsByClampedValue.has(clamped)
    && state.callIdsByClampedValue.get(clamped) !== callId) {
    return fail(
      "Distinct call identifiers collide after compatibility normalization.",
      path,
      "call_id_collision",
    );
  }
  state.callIdsByClampedValue.set(clamped, callId);
  return pass(clamped);
}

function normalizeContent(content, path, state) {
  if (typeof content === "string") return pass(content);
  if (!Array.isArray(content)) {
    return fail("Message content must be a string or an array.", path, "invalid_type");
  }

  const limitError = addContentParts(state, content.length, path);
  if (limitError) return limitError;

  const normalized = [];
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    const partPath = `${path}[${index}]`;
    if (!isRecord(part)) {
      return fail("Content parts must be JSON objects.", partPath, "invalid_type");
    }
    if (!SUPPORTED_CONTENT_TYPES.has(part.type)) {
      return fail("This content type is not supported by the local adapter.", `${partPath}.type`, "unsupported_parameter");
    }
    if (part.type === RESPONSES_ITEM.INPUT_TEXT || part.type === RESPONSES_ITEM.OUTPUT_TEXT) {
      if (typeof part.text !== "string") {
        return fail("Text content requires a string text value.", `${partPath}.text`, "invalid_type");
      }
    }
    if (part.type === RESPONSES_ITEM.INPUT_IMAGE) {
      if (hasOwn(part, "file_id")) {
        return fail("File-backed images are not supported by the local adapter.", `${partPath}.file_id`, "unsupported_parameter");
      }
      if (!isPortableImageUrl(part.image_url)) {
        return fail("Image input requires an HTTP(S) URL or valid image data URI.", `${partPath}.image_url`);
      }
    }
    normalized.push({ ...part });
  }
  return pass(normalized);
}

function toolName(tool, path) {
  if (hasOwn(tool, "name")) return pass({ name: tool.name, path: `${path}.name` });
  if (isRecord(tool.function)) {
    return pass({ name: tool.function.name, path: `${path}.function.name` });
  }
  return pass({ name: undefined, path: `${path}.name` });
}

function validateTool(tool, path) {
  if (!isRecord(tool)) {
    return fail("Tool definitions must be JSON objects.", path, "invalid_type");
  }
  if (!SUPPORTED_TOOL_TYPES.has(tool.type)) {
    return fail("Hosted tools are not supported by the local adapter.", `${path}.type`, "unsupported_parameter");
  }
  if (tool.function !== undefined && !isRecord(tool.function)) {
    return fail("function must be a JSON object.", `${path}.function`, "invalid_type");
  }
  if (tool.type === "custom" && tool.function !== undefined) {
    return fail("Custom tools cannot use the nested function shape.", `${path}.function`, "invalid_value");
  }

  const nameResult = toolName(tool, path);
  const { name, path: namePath } = nameResult.value;
  if (typeof name !== "string" || name.trim() === "") {
    return fail("Tool names must be non-empty strings.", namePath);
  }
  if (hasOwn(tool, "name") && isRecord(tool.function)
    && tool.function.name !== undefined && tool.function.name !== tool.name) {
    return fail("A tool cannot declare conflicting names.", `${path}.function.name`);
  }

  const parametersPath = hasOwn(tool, "parameters")
    ? `${path}.parameters`
    : `${path}.function.parameters`;
  const parameters = hasOwn(tool, "parameters") ? tool.parameters : tool.function?.parameters;
  if (parameters !== undefined && !isRecord(parameters)) {
    return fail("Tool parameters must be a JSON object.", parametersPath, "invalid_type");
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    return fail("Tool descriptions must be strings.", `${path}.description`, "invalid_type");
  }
  if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
    return fail("strict must be a boolean.", `${path}.strict`, "invalid_type");
  }
  if (tool.format !== undefined && !isRecord(tool.format)) {
    return fail("Custom tool format must be a JSON object.", `${path}.format`, "invalid_type");
  }
  return null;
}

function normalizeToolList(tools, path, state) {
  if (!Array.isArray(tools)) {
    return fail("Tools must be an array.", path, "invalid_type");
  }
  if (state.toolCount + tools.length > MAX_DECLARED_TOOLS) {
    return fail(
      `Responses requests support at most ${MAX_DECLARED_TOOLS} declared tools.`,
      path,
      "limit_exceeded",
    );
  }
  state.toolCount += tools.length;

  const normalized = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    const error = validateTool(tool, `${path}[${index}]`);
    if (error) return error;
    normalized.push({
      ...tool,
      ...(isRecord(tool.function) ? { function: { ...tool.function } } : {}),
      ...(isRecord(tool.parameters) ? { parameters: { ...tool.parameters } } : {}),
      ...(isRecord(tool.format) ? { format: { ...tool.format } } : {}),
    });
  }
  return pass(normalized);
}

function normalizeReasoningItem(item, path, state) {
  const normalized = { ...item };
  for (const field of ["summary", "content"]) {
    if (item[field] === undefined) continue;
    if (!Array.isArray(item[field])) {
      return fail(`Reasoning ${field} must be an array.`, `${path}.${field}`, "invalid_type");
    }
    const limitError = addContentParts(state, item[field].length, `${path}.${field}`);
    if (limitError) return limitError;
    const parts = [];
    for (let index = 0; index < item[field].length; index += 1) {
      const part = item[field][index];
      const partPath = `${path}.${field}[${index}]`;
      if (!isRecord(part)) {
        return fail("Reasoning parts must be JSON objects.", partPath, "invalid_type");
      }
      if (typeof part.text !== "string") {
        return fail("Reasoning parts require a string text value.", `${partPath}.text`, "invalid_type");
      }
      parts.push({ ...part });
    }
    normalized[field] = parts;
  }
  return pass(normalized);
}

function normalizeItem(item, path, state) {
  if (!isRecord(item)) {
    return fail("Input items must be JSON objects.", path, "invalid_type");
  }

  const itemType = item.type ?? (item.role ? RESPONSES_ITEM.MESSAGE : null);
  if (!SUPPORTED_INPUT_ITEM_TYPES.has(itemType)) {
    return fail("This input item type is not supported by the local adapter.", `${path}.type`, "unsupported_parameter");
  }

  const normalized = { ...item, type: itemType };
  if (itemType === RESPONSES_ITEM.MESSAGE) {
    if (!SUPPORTED_MESSAGE_ROLES.has(item.role)) {
      return fail("Message role is not supported.", `${path}.role`, "invalid_value");
    }
    const contentResult = normalizeContent(item.content, `${path}.content`, state);
    if (!contentResult.ok) return contentResult;
    normalized.content = contentResult.value;
  } else if (itemType === RESPONSES_ITEM.REASONING) {
    return normalizeReasoningItem(normalized, path, state);
  } else if (itemType === RESPONSES_ITEM.FUNCTION_CALL || itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
    if (typeof item.name !== "string" || item.name.trim() === "") {
      return fail("Tool-call names must be non-empty strings.", `${path}.name`);
    }
    const callIdResult = normalizeCallId(item.call_id, `${path}.call_id`, state);
    if (!callIdResult.ok) return callIdResult;
    normalized.call_id = callIdResult.value;
    if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      normalized.arguments = stringifyWireValue(item.arguments, {});
    } else {
      normalized.input = stringifyWireValue(item.input, "");
    }
  } else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT
    || itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) {
    const callIdResult = normalizeCallId(item.call_id, `${path}.call_id`, state);
    if (!callIdResult.ok) return callIdResult;
    normalized.call_id = callIdResult.value;
    normalized.output = stringifyWireValue(item.output, "");
  } else if (itemType === RESPONSES_ITEM.ADDITIONAL_TOOLS) {
    const toolsResult = normalizeToolList(item.tools, `${path}.tools`, state);
    if (!toolsResult.ok) return toolsResult;
    normalized.tools = toolsResult.value;
  }
  return pass(normalized);
}

function normalizeInput(input, state) {
  if (typeof input === "string") {
    return input.trim() === ""
      ? fail("input must not be empty.", "input")
      : pass(input);
  }
  if (!Array.isArray(input)) {
    return fail("input must be a string or an array.", "input", "invalid_type");
  }
  if (input.length === 0) return fail("input must not be empty.", "input");
  if (input.length > MAX_INPUT_ITEMS) {
    return fail(`Responses requests support at most ${MAX_INPUT_ITEMS} input items.`, "input", "limit_exceeded");
  }

  const normalized = [];
  for (let index = 0; index < input.length; index += 1) {
    const itemResult = normalizeItem(input[index], `input[${index}]`, state);
    if (!itemResult.ok) return itemResult;
    normalized.push(itemResult.value);
  }
  return pass(normalized);
}

function normalizeToolChoice(toolChoice) {
  if (typeof toolChoice === "string") {
    return SUPPORTED_STRING_TOOL_CHOICES.has(toolChoice)
      ? pass(toolChoice)
      : fail("tool_choice must be auto, none, required, or a named tool.", "tool_choice");
  }
  if (!isRecord(toolChoice)) {
    return fail("tool_choice must be a string or JSON object.", "tool_choice", "invalid_type");
  }
  if (!SUPPORTED_TOOL_TYPES.has(toolChoice.type)) {
    return fail("This tool_choice type is not supported.", "tool_choice.type", "unsupported_parameter");
  }
  if (typeof toolChoice.name !== "string" || toolChoice.name.trim() === "") {
    return fail("Named tool choices require a non-empty name.", "tool_choice.name");
  }
  return pass({ ...toolChoice });
}

export function validateAndNormalizeResponsesRequest(body) {
  if (!isRecord(body)) {
    return fail("Request body must be a JSON object.", null, "invalid_type");
  }
  if (body.background !== undefined && typeof body.background !== "boolean") {
    return fail("background must be a boolean.", "background", "invalid_type");
  }
  if (body.background === true) {
    return fail("Background responses are not supported by the local adapter.", "background", "unsupported_parameter");
  }
  if (body.store !== undefined && typeof body.store !== "boolean") {
    return fail("store must be a boolean.", "store", "invalid_type");
  }
  if (body.store === true) {
    return fail("Stored responses are not supported by the local adapter.", "store", "unsupported_parameter");
  }
  if (hasOwn(body, "conversation")) {
    return fail("Conversations are not supported by the local adapter.", "conversation", "unsupported_parameter");
  }
  if (hasOwn(body, "previous_response_id")) {
    return fail("Stored response lookup is not supported by the local adapter.", "previous_response_id", "unsupported_parameter");
  }
  if (!hasOwn(body, "input")) {
    return fail("input is required.", "input");
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    return fail("instructions must be a string.", "instructions", "invalid_type");
  }

  const state = {
    callIdsByClampedValue: new Map(),
    contentPartCount: 0,
    toolCount: 0,
  };
  const inputResult = normalizeInput(body.input, state);
  if (!inputResult.ok) return inputResult;

  const value = { ...body, input: inputResult.value, store: false };
  delete value.background;
  delete value.conversation;
  delete value.previous_response_id;

  if (body.tools !== undefined) {
    const toolsResult = normalizeToolList(body.tools, "tools", state);
    if (!toolsResult.ok) return toolsResult;
    value.tools = toolsResult.value;
  }
  if (body.tool_choice !== undefined) {
    const toolChoiceResult = normalizeToolChoice(body.tool_choice);
    if (!toolChoiceResult.ok) return toolChoiceResult;
    value.tool_choice = toolChoiceResult.value;
  }

  return pass(value);
}

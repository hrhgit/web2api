import path from "node:path";

export const API_VERSION = "web2api.v1";
export const OUTPUT_FORMATS = new Set(["text", "markdown", "latex"]);
export const ARTIFACT_POLICIES = new Set(["none", "collect"]);
export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_login", "cancelled"]);

export class ApiError extends Error {
  constructor(code, message, { status = 400, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, label, { maxLength = 20_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_request", `${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ApiError("invalid_request", `${label} exceeds the ${maxLength}-character limit.`);
  }
  return value;
}

function unsupported(field, explanation) {
  throw new ApiError(
    "unsupported_feature",
    `${field} is not supported by web2api's browser-backed v1 contract. ${explanation}`,
  );
}

function rejectUnknownFields(value, allowed, prefix = "") {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      unsupported(`${prefix}${field}`, "Unknown request fields are not silently ignored.");
    }
  }
}

function normalizeInput(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError("invalid_request", "input must be a non-empty array of text and/or local_file items.");
  }

  const normalized = input.map((item, index) => {
    if (!isRecord(item)) {
      throw new ApiError("invalid_request", `input[${index}] must be an object.`);
    }
    if (item.type === "text") {
      rejectUnknownFields(item, ["type", "text"], `input[${index}].`);
      return { type: "text", text: nonEmptyString(item.text, `input[${index}].text`) };
    }
    if (item.type === "local_file") {
      rejectUnknownFields(item, ["type", "path"], `input[${index}].`);
      const filePath = nonEmptyString(item.path, `input[${index}].path`, { maxLength: 8_192 });
      if (!path.isAbsolute(filePath)) {
        throw new ApiError("invalid_request", `input[${index}].path must be an absolute local path.`);
      }
      return { type: "local_file", path: path.resolve(filePath) };
    }
    throw new ApiError("invalid_request", `input[${index}].type must be text or local_file.`);
  });

  if (!normalized.some((item) => item.type === "text")) {
    throw new ApiError("invalid_request", "input must include at least one text item containing the task instruction.");
  }
  return normalized;
}

function normalizeOutput(output = {}) {
  if (!isRecord(output)) {
    throw new ApiError("invalid_request", "output must be an object when provided.");
  }
  const format = output.format ?? "text";
  if (!OUTPUT_FORMATS.has(format)) {
    throw new ApiError("invalid_request", "output.format must be text, markdown, or latex.");
  }
  if ("enforcement" in output) {
    unsupported(
      "output.enforcement",
      "The provider reports how an output contract was enforced after the job completes.",
    );
  }
  rejectUnknownFields(output, ["format"], "output.");
  return { format };
}

export function normalizeGenerationRequest(payload) {
  if (!isRecord(payload)) {
    throw new ApiError("invalid_request", "Request body must be a JSON object.");
  }
  rejectUnknownFields(payload, ["provider", "input", "output", "artifactPolicy", "idempotencyKey", "timeoutMs", "model", "conversationId"]);
  if ("conversationId" in payload && (typeof payload.conversationId !== "string" ||
      !/^(?:new|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(payload.conversationId))) {
    throw new ApiError("invalid_request", "conversationId must be new or a returned conversation ID.");
  }

  const provider = nonEmptyString(payload.provider, "provider", { maxLength: 128 });
  const artifactPolicy = payload.artifactPolicy ?? "collect";
  if (!ARTIFACT_POLICIES.has(artifactPolicy)) {
    throw new ApiError("invalid_request", "artifactPolicy must be none or collect.");
  }

  const timeoutMs = payload.timeoutMs ?? 15 * 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 30 * 60_000) {
    throw new ApiError("invalid_request", "timeoutMs must be an integer from 30000 through 1800000.");
  }

  const idempotencyKey = payload.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    nonEmptyString(idempotencyKey, "idempotencyKey", { maxLength: 256 });
  }

  return {
    provider,
    ...("conversationId" in payload ? { conversationId: payload.conversationId } : {}),
    ...("model" in payload ? { model: nonEmptyString(payload.model, "model", { maxLength: 128 }) } : {}),
    input: normalizeInput(payload.input),
    output: normalizeOutput(payload.output),
    artifactPolicy,
    idempotencyKey,
    timeoutMs,
  };
}

export function assertProviderSupportsRequest(provider, request) {
  const capabilities = provider.capabilities;
  if (request.conversationId && !capabilities.conversations?.native) {
    throw new ApiError("unsupported_feature", `Provider ${provider.id} does not support native conversations.`, { status: 422 });
  }
  if ("model" in request && capabilities.modelSelection !== true) {
    throw new ApiError("unsupported_feature", `Provider ${provider.id} does not support model selection.`, { status: 422 });
  }
  const hasFiles = request.input.some((item) => item.type === "local_file");
  if (hasFiles && capabilities.input?.localFiles !== true) {
    throw new ApiError(
      "unsupported_feature",
      `Provider ${provider.id} does not support local file attachments.`,
      { status: 422 },
    );
  }
  if (!capabilities.output?.formats?.includes(request.output.format)) {
    throw new ApiError(
      "unsupported_feature",
      `Provider ${provider.id} does not support ${request.output.format} output.`,
      { status: 422 },
    );
  }
}

export function publicError(error) {
  if (error instanceof ApiError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "An unexpected server error occurred." } },
  };
}

import process from "node:process";

const MAX_ERROR_MESSAGE_LENGTH = 240;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const SENSITIVE_ASSIGNMENT = /\b(?:authorization|cookie|token|password|secret|api[_-]?key|session(?:_?id)?)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~-]+/giu;
const URL = /\b(?:https?|file):\/\/[^\s"'`]+/giu;
const ABSOLUTE_PATH = /(?:^|[\s("'`])(?:\/(?:Users|home|private|var|tmp|Volumes)\/|[A-Za-z]:\\)[^\s"'`]+/gu;

function truncate(value) {
  return value.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`
    : value;
}

export function safeDiagnosticIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTIFIER.test(normalized) ? normalized : null;
}

// Browser/Playwright errors sometimes include profile paths, URLs, or request
// headers. Keep the actionable reason while ensuring public job records and
// optional debug streams never become a source of credentials or source data.
export function sanitizeDiagnosticMessage(value, fallback = "Unknown error") {
  const message = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!message) return fallback;
  const redacted = message
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.split(/[:=]/u, 1)[0]}=<redacted>`)
    .replace(BEARER_TOKEN, "Bearer <redacted>")
    .replace(URL, "<url>")
    .replace(ABSOLUTE_PATH, (match) => {
      const prefix = /^[\s("'`]/u.exec(match)?.[0] || "";
      return `${prefix}<path>`;
    });
  return truncate(redacted || fallback);
}

export function createUploadDebugLogger({ environment = process.env, stream = process.stderr } = {}) {
  if (environment.WEB2API_UPLOAD_DEBUG !== "1") return null;
  return (event, details = {}) => {
    stream.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...details })}\n`);
  };
}

export function summarizeError(error) {
  return {
    name: safeDiagnosticIdentifier(error?.name) || "Error",
    code: safeDiagnosticIdentifier(error?.code),
    message: sanitizeDiagnosticMessage(error?.message || error),
  };
}

export function providerFailureDiagnostic(error, { phase = "provider_generation" } = {}) {
  return {
    phase: safeDiagnosticIdentifier(phase) || "provider_generation",
    underlying: summarizeError(error),
  };
}

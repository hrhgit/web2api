import process from "node:process";

const MAX_ERROR_MESSAGE_LENGTH = 240;

export function createUploadDebugLogger({ environment = process.env, stream = process.stderr } = {}) {
  if (environment.WEB2API_UPLOAD_DEBUG !== "1") return null;
  return (event, details = {}) => {
    stream.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...details })}\n`);
  };
}

export function summarizeError(error) {
  const message = String(error?.message || error || "Unknown error");
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: message.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`
      : message,
  };
}

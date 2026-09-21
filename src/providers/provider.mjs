export class ProviderError extends Error {
  constructor(code, message, { details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

export function browserCapabilities({
  localFiles = false,
  outputFormats = ["text"],
  artifacts = { downloadableFiles: false, generatedImages: false },
  login = "none",
  modelSelection = false,
} = {}) {
  return {
    input: { text: true, localFiles },
    output: { formats: outputFormats },
    artifacts,
    systemInstructions: false,
    toolCalls: false,
    streaming: false,
    modelSelection,
    tokenUsage: false,
    session: login === "persistent_local_profile" ? "persistent_local_profile" : "none",
  };
}

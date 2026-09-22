import { browserCapabilities } from "./provider.mjs";

function render(text, format) {
  if (format === "markdown") return `# Mock web response\n\n${text}\n`;
  return text;
}

export class MockWebProvider {
  constructor() {
    this.id = "mock-web";
    this.displayName = "Mock Web";
    this.capabilities = browserCapabilities({ outputFormats: ["text", "markdown", "latex"], readinessCheck: true, runningCancellation: true });
  }

  async check() {}

  async generate(request) {
    const text = request.input
      .filter((item) => item.type === "text")
      .map((item) => item.text.trim())
      .join("\n\n");
    return {
      text: render(`Mock provider received: ${text}`, request.output.format),
      outputEnforcement: "provider_generated_mock",
      artifacts: [],
      providerMetadata: { synthetic: true },
    };
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, assertProviderSupportsRequest, normalizeGenerationRequest } from "../src/core/contracts.mjs";
import { browserCapabilities } from "../src/providers/provider.mjs";
import { GeminiWebProvider } from "../src/providers/gemini-web.mjs";
import { OpenAIWebProvider } from "../src/providers/openai-web.mjs";

test("normalizes a narrow browser-generation request", () => {
  const request = normalizeGenerationRequest({
    provider: "gemini-web",
    input: [
      { type: "text", text: "Extract this in Markdown." },
      { type: "local_file", path: "/tmp/source.pdf" },
    ],
    output: { format: "markdown" },
    idempotencyKey: "paper-001",
  });

  assert.equal(request.provider, "gemini-web");
  assert.equal(request.output.format, "markdown");
  assert.equal(request.input[1].path, "/tmp/source.pdf");
  assert.equal(request.artifactPolicy, "collect");
});

for (const field of ["system", "instructions", "developer", "tools", "tool_choice", "temperature", "stream"]) {
  test(`rejects unsupported ${field} instead of converting it into a prompt`, () => {
    assert.throws(
      () => normalizeGenerationRequest({
        provider: "mock-web",
        input: [{ type: "text", text: "hello" }],
        [field]: field === "tools" ? [] : "value",
      }),
      (error) => error instanceof ApiError && error.code === "unsupported_feature",
    );
  });
}

test("rejects unknown top-level and nested fields instead of dropping them", () => {
  const request = { provider: "mock-web", input: [{ type: "text", text: "hello" }] };
  for (const payload of [
    { ...request, messages: [] },
    { ...request, providerOptions: { size: "large" } },
    { ...request, output: { format: "text", mode: "extract" } },
    { ...request, input: [{ type: "text", text: "hello", role: "system" }] },
    { ...request, input: [...request.input, { type: "local_file", path: "/tmp/source.pdf", uploadMode: "image" }] },
  ]) {
    assert.throws(() => normalizeGenerationRequest(payload), (error) => error.code === "unsupported_feature");
  }
});

test("model selection is validated against the selected provider", () => {
  const request = normalizeGenerationRequest({
    provider: "selectable-web", input: [{ type: "text", text: "hello" }], model: "web-model-a",
  });
  assert.equal(request.model, "web-model-a");
  assert.doesNotThrow(() => assertProviderSupportsRequest({ id: request.provider, capabilities: browserCapabilities({ modelSelection: true }) }, request));
  assert.throws(() => assertProviderSupportsRequest({ id: "no-selection", capabilities: browserCapabilities() }, request),
    (error) => error.code === "unsupported_feature" && error.status === 422);
});

test("Gemini accepts its declared text extraction formats", () => {
  const provider = new GeminiWebProvider();
  assert.deepEqual(provider.capabilities.output.formats, ["text", "markdown", "latex"]);
  assert.equal(provider.uploadMethod, "menu");
  assert.equal(provider.attachmentSettleMs, 2_000);
  assert.equal(new GeminiWebProvider({ uploadMethod: "native", attachmentSettleMs: 0 }).uploadMethod, "native");
  assert.equal(new GeminiWebProvider({ uploadMethod: "native", attachmentSettleMs: 0 }).attachmentSettleMs, 0);
  for (const format of ["text", "markdown", "latex"]) {
    const request = normalizeGenerationRequest({ provider: provider.id, input: [{ type: "text", text: "hello" }], output: { format } });
    assert.doesNotThrow(() => assertProviderSupportsRequest(provider, request));
  }
  const request = normalizeGenerationRequest({ provider: "text-only", input: [{ type: "text", text: "hello" }], output: { format: "markdown" } });
  assert.throws(() => assertProviderSupportsRequest({ id: request.provider, capabilities: browserCapabilities() }, request),
    (error) => error.code === "unsupported_feature");
});

test("requires explicit task text and an absolute local file path", () => {
  assert.throws(
    () => normalizeGenerationRequest({
      provider: "mock-web",
      input: [{ type: "local_file", path: "paper.pdf" }],
    }),
    (error) => error instanceof ApiError && error.code === "invalid_request",
  );
});

test("OpenAI declares text extraction and rejects unimplemented attachment and model controls", () => {
  const provider = new OpenAIWebProvider();
  for (const format of ["text", "markdown", "latex"]) {
    const request = normalizeGenerationRequest({ provider: provider.id, input: [{ type: "text", text: "hello" }], output: { format } });
    assert.doesNotThrow(() => assertProviderSupportsRequest(provider, request));
  }
  for (const extra of [{ model: "some-model" }, { input: [{ type: "text", text: "hello" }, { type: "local_file", path: "/tmp/input.txt" }] }]) {
    const request = normalizeGenerationRequest({ provider: provider.id, input: [{ type: "text", text: "hello" }], ...extra });
    assert.throws(() => assertProviderSupportsRequest(provider, request), (error) => error.code === "unsupported_feature" && error.status === 422);
  }
  assert.notEqual(provider.settings.profileDirectory, new GeminiWebProvider().settings.profileDirectory);
  assert.deepEqual(provider.capabilities.artifacts, { downloadableFiles: false, generatedImages: false });
});

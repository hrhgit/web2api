import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Web2ApiGateway } from "../src/core/gateway.mjs";
import { FileJobStore } from "../src/core/job-store.mjs";
import { normalizeGenerationRequest } from "../src/core/contracts.mjs";
import { browserCapabilities, ProviderError } from "../src/providers/provider.mjs";

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

class RecordingProvider {
  constructor({ needsLogin = false, withArtifact = false } = {}) {
    this.id = needsLogin ? "login-web" : withArtifact ? "artifact-web" : "recording-web";
    this.displayName = this.id;
    this.calls = 0;
    this.needsLogin = needsLogin;
    this.withArtifact = withArtifact;
    this.capabilities = browserCapabilities({ localFiles: true, outputFormats: ["text", "markdown", "latex"], artifacts: { downloadableFiles: true, generatedImages: true } });
  }

  async generate(request, { jobDirectory }) {
    this.calls += 1;
    if (this.needsLogin) throw new ProviderError("needs_login", "Login is required.");
    const artifacts = [];
    if (this.withArtifact) {
      const sourcePath = path.join(jobDirectory, "provider-created.md");
      await writeFile(sourcePath, "# Generated artifact\n", "utf8");
      artifacts.push({
        sourcePath,
        fileName: "generated.md",
        mediaType: "text/markdown",
        originUrl: "https://example.invalid/conversation/123",
      });
    }
    return {
      text: `received ${request.input.filter((item) => item.type === "text").length} text item(s)`,
      outputEnforcement: "provider_native_test",
      artifacts,
    };
  }
}

test("persists a queued job, runs it once, and honors an idempotency key", async () => {
  const provider = new RecordingProvider();
  const gateway = await new Web2ApiGateway({
    dataDirectory: await temporaryDirectory("web2api-gateway-"),
    providers: [provider],
  }).init();
  const request = {
    provider: provider.id,
    input: [{ type: "text", text: "Explain this." }],
    output: { format: "markdown" },
    idempotencyKey: "same-logical-request",
  };

  const queued = await gateway.submit(request);
  assert.equal(queued.status, "queued");
  const duplicate = await gateway.submit(request);
  assert.equal(duplicate.id, queued.id);
  const completed = await gateway.waitForTerminal(queued.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.enforcement, "provider_native_test");
  assert.equal(provider.calls, 1);
  assert.deepEqual(completed.request.input, [{ type: "text", characters: 13 }]);
});

async function reviewGateway(t, providers) {
  const dataDirectory = await temporaryDirectory("web2api-regression-");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return new Web2ApiGateway({ dataDirectory, providers }).init();
}

test("concurrent duplicate submissions execute once and remain idempotent after restart", async (t) => {
  const provider = new RecordingProvider();
  const gateway = await reviewGateway(t, [provider]);
  const request = { provider: provider.id, input: [{ type: "text", text: "hello" }], idempotencyKey: "concurrent" };
  const jobs = await Promise.all(Array.from({ length: 8 }, () => gateway.submit(request)));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  await gateway.waitForTerminal(jobs[0].id);
  assert.equal(provider.calls, 1);
  const restarted = await new Web2ApiGateway({ dataDirectory: gateway.store.dataDirectory, providers: [provider] }).init();
  const duplicate = await restarted.submit(request);
  assert.equal(duplicate.id, jobs[0].id);
  assert.equal(duplicate.status, "completed");
  assert.equal(provider.calls, 1);
});

test("reusing a key with different input returns a conflict without poisoning admission", async (t) => {
  const provider = new RecordingProvider();
  const gateway = await reviewGateway(t, [provider]);
  const request = { provider: provider.id, input: [{ type: "text", text: "first" }], idempotencyKey: "conflict" };
  const [first, second] = await Promise.allSettled([
    gateway.submit(request),
    gateway.submit({ ...request, input: [{ type: "text", text: "different" }] }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "idempotency_conflict");
  assert.equal(second.reason.status, 409);
  await gateway.waitForTerminal(first.value.id);
  assert.equal((await gateway.submit(request)).id, first.value.id);
  assert.equal(provider.calls, 1);
});

test("startup terminates interrupted jobs without resending or discarding saved results", async (t) => {
  const dataDirectory = await temporaryDirectory("web2api-restart-");
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new FileJobStore(dataDirectory);
  await store.init();
  const provider = new RecordingProvider();
  const saved = [];
  for (const status of ["queued", "running", "completed", "failed", "needs_login"]) {
    const job = {
      id: randomUUID(), provider: provider.id, status,
      request: normalizeGenerationRequest({ provider: provider.id, input: [{ type: "text", text: status }], idempotencyKey: status }),
      output: status === "running" ? { text: "already generated", format: "text", enforcement: "test" } : null,
      artifacts: [], error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.create(job);
    saved.push(job);
  }
  const gateway = await new Web2ApiGateway({ dataDirectory, providers: [provider] }).init();
  for (const original of saved) {
    const job = await gateway.getJob(original.id);
    if (["queued", "running"].includes(original.status)) {
      assert.equal(job.status, "failed");
      assert.equal(job.error.code, "interrupted");
      assert.ok(job.completedAt);
      assert.deepEqual(job.output, original.output);
      assert.equal((await gateway.submit(original.request)).id, original.id);
    } else {
      assert.deepEqual(await store.get(original.id), original);
    }
  }
  assert.equal(provider.calls, 0);
});

test("artifact failures preserve text and successful files on both sides of a failure", async (t) => {
  const provider = {
    id: "partial-artifacts", capabilities: browserCapabilities({ artifacts: { downloadableFiles: true, generatedImages: false } }),
    async generate(_request, { jobDirectory }) {
      const sourcePath = path.join(jobDirectory, "source.txt");
      await writeFile(sourcePath, "saved file");
      return {
        text: "saved answer", outputEnforcement: "test",
        artifacts: [
          { sourcePath, fileName: "first.txt" },
          { sourcePath: path.join(jobDirectory, "missing.txt") },
          { sourcePath, fileName: "last.txt" },
        ],
      };
    },
  };
  const gateway = await reviewGateway(t, [provider]);
  const queued = await gateway.submit({ provider: provider.id, input: [{ type: "text", text: "files please" }] });
  const failed = await gateway.waitForTerminal(queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.output.text, "saved answer");
  assert.deepEqual(failed.artifacts.map((artifact) => artifact.fileName), ["first.txt", "last.txt"]);
  assert.equal(failed.error.code, "artifact_collection_failed");
  assert.equal(failed.error.details.failures[0].index, 1);
  assert.equal(failed.error.details.failures[0].code, "artifact_missing");
  assert.equal(JSON.stringify(failed).includes(gateway.store.dataDirectory), false);
  for (const artifact of failed.artifacts) {
    const stored = await gateway.getArtifact(failed.id, artifact.id);
    assert.equal(await readFile(path.join(stored.jobDirectory, stored.artifact.storedPath), "utf8"), "saved file");
  }
  const ignored = await gateway.submit({ provider: provider.id, input: [{ type: "text", text: "files please" }], artifactPolicy: "none" });
  const complete = await gateway.waitForTerminal(ignored.id);
  assert.equal(complete.status, "completed");
  assert.deepEqual(complete.artifacts, []);
});

test("capability-approved model selection reaches the provider and public job", async (t) => {
  let received;
  const provider = {
    id: "selectable", capabilities: browserCapabilities({ modelSelection: true }),
    async generate(request) { received = request.model; return { text: "answer", outputEnforcement: "test" }; },
  };
  const gateway = await reviewGateway(t, [provider]);
  const queued = await gateway.submit({ provider: provider.id, model: "web-model-a", input: [{ type: "text", text: "hello" }] });
  const result = await gateway.waitForTerminal(queued.id);
  assert.equal(result.status, "completed");
  assert.equal(received, "web-model-a");
  assert.equal(result.request.model, "web-model-a");
});

test("admission serialization preserves per-provider FIFO and cross-provider concurrency", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const calls = [];
  const slow = {
    id: "slow", capabilities: browserCapabilities(),
    async generate(request) {
      const text = request.input[0].text;
      calls.push(text);
      if (text === "first") { started.resolve(); await release.promise; }
      return { text, outputEnforcement: "test" };
    },
  };
  const fast = new RecordingProvider();
  const gateway = await reviewGateway(t, [slow, fast]);
  const first = await gateway.submit({ provider: slow.id, input: [{ type: "text", text: "first" }] });
  await started.promise;
  const second = await gateway.submit({ provider: slow.id, input: [{ type: "text", text: "second" }] });
  const other = await gateway.submit({ provider: fast.id, input: [{ type: "text", text: "independent" }] });
  assert.equal((await gateway.waitForTerminal(other.id)).status, "completed");
  assert.deepEqual(calls, ["first"]);
  release.resolve();
  await gateway.waitForTerminal(first.id);
  await gateway.waitForTerminal(second.id);
  assert.deepEqual(calls, ["first", "second"]);
});

test("a provider returning after its deadline cannot complete successfully", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const provider = {
    id: "late", capabilities: browserCapabilities(),
    async generate() { started.resolve(); await release.promise; return { text: "late", outputEnforcement: "test" }; },
  };
  const gateway = await reviewGateway(t, [provider]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queued = await gateway.submit({ provider: provider.id, input: [{ type: "text", text: "wait" }], timeoutMs: 30000 });
  await started.promise;
  t.mock.timers.tick(30000);
  t.mock.timers.reset();
  release.resolve();
  const failed = await gateway.waitForTerminal(queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "timeout");
});

test("records needs_login without claiming the request was sent", async () => {
  const provider = new RecordingProvider({ needsLogin: true });
  const gateway = await new Web2ApiGateway({
    dataDirectory: await temporaryDirectory("web2api-login-"),
    providers: [provider],
  }).init();

  const queued = await gateway.submit({
    provider: provider.id,
    input: [{ type: "text", text: "hello" }],
  });
  const finished = await gateway.waitForTerminal(queued.id);
  assert.equal(finished.status, "needs_login");
  assert.equal(finished.error.code, "needs_login");
});

test("stages provider files with digest metadata and hides storage paths", async () => {
  const provider = new RecordingProvider({ withArtifact: true });
  const gateway = await new Web2ApiGateway({
    dataDirectory: await temporaryDirectory("web2api-artifact-"),
    providers: [provider],
  }).init();
  const queued = await gateway.submit({
    provider: provider.id,
    input: [{ type: "text", text: "make an artifact" }],
  });
  const finished = await gateway.waitForTerminal(queued.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.artifacts.length, 1);
  const artifact = finished.artifacts[0];
  assert.equal(artifact.fileName, "generated.md");
  assert.equal(artifact.mediaType, "text/markdown");
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.match(artifact.downloadUrl, new RegExp(`/v1/jobs/${finished.id}/artifacts/`));
  assert.equal("storedPath" in artifact, false);

  const internal = await gateway.getArtifact(finished.id, artifact.id);
  const contents = await readFile(path.join(internal.jobDirectory, internal.artifact.storedPath), "utf8");
  assert.equal(contents, "# Generated artifact\n");
});

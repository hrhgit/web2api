import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Web2ApiGateway } from "../src/core/gateway.mjs";
import { browserCapabilities, ProviderError } from "../src/providers/provider.mjs";
import { createApiServer, listenLocal } from "../src/server.mjs";
import { Web2ApiClient } from "../src/client.mjs";

async function fixture(t, overrides = {}) {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const provider = {
    id: "test-web", capabilities: browserCapabilities({ readinessCheck: true, runningCancellation: true, submissionTracking: true }),
    async check() {},
    async generate(request, { signal, reportSubmission }) {
      calls.push(request.input[0].text);
      await reportSubmission("unknown");
      await reportSubmission("confirmed");
      started.resolve();
      await Promise.race([release.promise, new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      })]);
      return { text: "answer", outputEnforcement: "test" };
    }, ...overrides,
  };
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "web2api-lifecycle-"));
  const gateway = await new Web2ApiGateway({ dataDirectory, providers: [provider] }).init();
  t.after(async () => { release.resolve(); await rm(dataDirectory, { recursive: true, force: true }); });
  const submit = (text) => gateway.submit({ provider: provider.id, input: [{ type: "text", text }], idempotencyKey: text });
  return { gateway, provider, started, release, calls, submit };
}

test("queued cancellation never starts; running cancellation releases execution and preserves submission state", async (t) => {
  const f = await fixture(t);
  const first = await f.submit("first");
  await f.started.promise;
  const second = await f.submit("second");
  assert.equal((await f.gateway.checkProvider(f.provider.id)).status, "busy");
  const cancelled = await f.gateway.cancelJob(second.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.submission, "not_sent");
  assert.equal(cancelled.cancellation.upstreamStopped, "not_applicable");
  assert.equal((await f.submit("second")).id, second.id);
  assert.equal((await f.gateway.cancelJob(first.id)).status, "cancelling");
  const terminal = await f.gateway.waitForTerminal(first.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.submission, "confirmed");
  assert.equal(terminal.cancellation.upstreamStopped, "unknown");
  assert.deepEqual(f.calls, ["first"]);
  assert.equal((await f.gateway.cancelJob(first.id)).status, "cancelled");
});

test("completed output survives cancellation; concurrent updates do not lose fields", async (t) => {
  const f = await fixture(t);
  const job = await f.submit("complete");
  f.release.resolve();
  await f.gateway.waitForTerminal(job.id);
  const cancelled = await f.gateway.cancelJob(job.id);
  assert.equal(cancelled.status, "completed");
  assert.equal(cancelled.output.text, "answer");
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.gateway.store.update(job.id, (current) => ({ ...current, [i]: i }))));
  const saved = await f.gateway.store.get(job.id);
  for (let i = 0; i < 20; i++) assert.equal(saved[i], i);
});

test("readiness distinguishes login, busy, unknown and exposes no error paths", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.gateway.checkProvider(f.provider.id)).status, "ready");
  for (const [code, status] of [["needs_login", "needs_login"], ["profile_busy", "busy"], ["other", "unknown"]]) {
    f.provider.check = async () => { throw new ProviderError(code, "/private/profile/secret"); };
    const result = await f.gateway.checkProvider(f.provider.id);
    assert.equal(result.status, status);
    assert.ok(result.checkedAt);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("readiness is exclusive with submissions and other checks", async (t) => {
  const checking = Promise.withResolvers();
  const releaseCheck = Promise.withResolvers();
  const f = await fixture(t, { async check() { checking.resolve(); await releaseCheck.promise; } });
  const check = f.gateway.checkProvider(f.provider.id);
  await checking.promise;
  const job = await f.submit("after-check");
  assert.equal((await f.gateway.checkProvider(f.provider.id)).status, "busy");
  assert.deepEqual(f.calls, []);
  releaseCheck.resolve();
  assert.equal((await check).status, "ready");
  await f.started.promise;
  await f.gateway.cancelJob(job.id);
  await f.gateway.waitForTerminal(job.id);
});

test("HTTP client supports authenticated checks, cancellation, and cancelled terminal jobs", async (t) => {
  const f = await fixture(t);
  const server = createApiServer({ gateway: f.gateway, token: "test-token" });
  const address = await listenLocal(server, { port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new Web2ApiClient({ baseUrl, token: "test-token" });
  assert.equal((await client.checkProvider(f.provider.id)).status, "ready");
  await assert.rejects(new Web2ApiClient({ baseUrl }).checkProvider(f.provider.id), (e) => e.status === 401);
  const job = await client.submit({ provider: f.provider.id, input: [{ type: "text", text: "cancel" }] });
  await f.started.promise;
  await client.cancel(job.id);
  assert.equal((await client.waitForTerminal(job.id)).status, "cancelled");
});

test("cancelling jobs are recovered as interrupted, never automatically resent", async (t) => {
  const f = await fixture(t);
  const request = { provider: f.provider.id, input: [{ type: "text", text: "old" }] };
  await f.gateway.store.create({ id: "cancelled-crash", provider: f.provider.id, request, status: "cancelling", output: { text: "retained" } });
  await f.gateway.init();
  const recovered = await f.gateway.getJob("cancelled-crash");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "interrupted");
  assert.equal(recovered.output.text, "retained");
  assert.deepEqual(f.calls, []);
});

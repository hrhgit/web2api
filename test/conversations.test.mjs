import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Web2ApiGateway } from "../src/core/gateway.mjs";
import { browserCapabilities } from "../src/providers/provider.mjs";
import { normalizeGenerationRequest } from "../src/core/contracts.mjs";
import { conversationAddress } from "../src/providers/conversation.mjs";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, generate) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "web2api-conversations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = { id: "fixture", capabilities: browserCapabilities({ nativeConversations: true, submissionTracking: true, runningCancellation: true, maxConcurrency: 3 }), generate };
  const gateway = await new Web2ApiGateway({ dataDirectory: directory, providers: [provider] }).init();
  return { gateway, provider, directory, submit: (text, conversationId = "new", extra = {}) => gateway.submit({ provider: provider.id, input: [{ type: "text", text }], conversationId, ...extra }) };
}
const output = (url = "https://gemini.google.com/app/fixture") => ({ text: "answer", outputEnforcement: "fixture", providerMetadata: { conversationUrl: url } });

test("same conversation queues without consuming other conversation slots; restart resumes saved address", async (t) => {
  const entered = deferred(); const release = deferred(); const calls = [];
  const f = await fixture(t, async (request, context) => {
    const text = request.input[0].text;
    calls.push([text, context.conversationUrl]);
    await context.reportSubmission("confirmed");
    if (text === "first") { entered.resolve(); await release.promise; }
    return output();
  });
  const first = await f.submit("first", "new", { idempotencyKey: "first" });
  await entered.promise;
  const second = await f.submit("second", first.conversationId);
  const third = await f.submit("third", first.conversationId);
  const independent = await f.submit("independent");
  await f.gateway.waitForTerminal(independent.id);
  assert.equal((await f.gateway.getJob(second.id)).status, "queued");
  assert.deepEqual(calls.map(([text]) => text), ["first", "independent"]);
  assert.equal((await f.submit("first", "new", { idempotencyKey: "first" })).conversationId, first.conversationId);
  release.resolve();
  await f.gateway.waitForTerminal(third.id);
  assert.deepEqual(calls.slice(2), [["second", output().providerMetadata.conversationUrl], ["third", output().providerMetadata.conversationUrl]]);
  const restarted = await new Web2ApiGateway({ dataDirectory: f.directory, providers: [f.provider] }).init();
  const next = await restarted.submit({ provider: "fixture", conversationId: first.conversationId, input: [{ type: "text", text: "after restart" }] });
  assert.equal((await restarted.waitForTerminal(next.id)).status, "completed");
  assert.equal(calls.at(-1)[1], output().providerMetadata.conversationUrl);
});

test("uncertain failure blocks already queued and later follow-ups", async (t) => {
  let calls = 0;
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, async (_request, context) => {
    calls++; await context.reportSubmission("unknown"); entered.resolve(); await release.promise; throw new Error("lost connection");
  });
  const first = await f.submit("first"); await entered.promise;
  const second = await f.submit("second", first.conversationId);
  release.resolve();
  assert.equal((await f.gateway.waitForTerminal(second.id)).error.code, "conversation_blocked");
  const third = await f.submit("third", first.conversationId);
  assert.equal((await f.gateway.waitForTerminal(third.id)).error.code, "conversation_blocked");
  assert.equal(calls, 1);
});

test("queued cancellation is skipped; running cancellation blocks the conversation", async (t) => {
  const entered = deferred(); const release = deferred(); const calls = [];
  const f = await fixture(t, async (request, context) => {
    calls.push(request.input[0].text); await context.reportSubmission("confirmed");
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    return output();
  });
  const first = await f.submit("first"); await entered.promise;
  const cancelled = await f.submit("cancel queued", first.conversationId);
  const next = await f.submit("next", first.conversationId);
  await f.gateway.cancelJob(cancelled.id); release.resolve();
  assert.equal((await f.gateway.waitForTerminal(next.id)).status, "completed");
  assert.deepEqual(calls, ["first", "next"]);
  const entered2 = deferred(); const release2 = deferred();
  f.provider.generate = async (_r, c) => { await c.reportSubmission("confirmed"); entered2.resolve(); await release2.promise; return output(); };
  const running = await f.submit("running", first.conversationId); await entered2.promise;
  const following = await f.submit("following", first.conversationId);
  await f.gateway.cancelJob(running.id); release2.resolve();
  assert.equal((await f.gateway.waitForTerminal(following.id)).error.code, "conversation_blocked");
});

test("restart after uncertain submission blocks a follow-up; provider and ID are validated", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return output(); });
  const first = await f.submit("first"); await f.gateway.waitForTerminal(first.id);
  await f.gateway.store.update(first.id, (job) => ({ ...job, status: "running", submission: "unknown" }));
  await f.gateway.init();
  const next = await f.submit("next", first.conversationId);
  assert.equal((await f.gateway.waitForTerminal(next.id)).error.code, "conversation_blocked");
  assert.equal(calls, 1);
  await assert.rejects(() => f.submit("missing", "00000000-0000-0000-0000-000000000000"), { code: "conversation_not_found" });
  f.gateway.register({ ...f.provider, id: "other" });
  await assert.rejects(() => f.gateway.submit({ provider: "other", conversationId: first.conversationId, input: [{ type: "text", text: "wrong provider" }] }), { code: "conversation_provider_mismatch" });
  assert.throws(() => normalizeGenerationRequest({ provider: "fixture", conversationId: "https://example.com", input: [{ type: "text", text: "bad" }] }), { code: "invalid_request" });
});

test("provider conversation addresses cannot navigate outside the expected conversation route", () => {
  for (const url of ["http://gemini.google.com/app/id", "https://evil.example/app/id", "https://user:pass@gemini.google.com/app/id", "https://gemini.google.com/app", "https://chatgpt.com/"]) {
    assert.throws(() => conversationAddress(url, "gemini-web"), { code: "conversation_unavailable" });
  }
  assert.equal(conversationAddress("https://chatgpt.com/c/abc?x=1", "openai-web"), "https://chatgpt.com/c/abc");
});

test("timeout cannot release a follow-up into a possibly still generating conversation", async (t) => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  const f = await fixture(t, async (_request, context) => {
    calls++; await context.reportSubmission("confirmed"); entered.resolve(); await release.promise; return output();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await f.submit("first", "new", { timeoutMs: 30000 }); await entered.promise;
  const next = await f.submit("next", first.conversationId);
  t.mock.timers.tick(30000); t.mock.timers.reset(); release.resolve();
  assert.equal((await f.gateway.waitForTerminal(first.id)).error.code, "timeout");
  assert.equal((await f.gateway.waitForTerminal(next.id)).error.code, "conversation_blocked");
  assert.equal(calls, 1);
});

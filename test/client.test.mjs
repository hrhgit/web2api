import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Web2ApiClient, Web2ApiClientError } from "../src/client.mjs";
import { createWeb2ApiApp } from "../src/app.mjs";
import { createApiServer, listenLocal } from "../src/server.mjs";

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createTestService(t, token = null) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "web2api-client-"));
  const { gateway } = await createWeb2ApiApp({ dataDirectory });
  const server = createApiServer({ gateway, token });
  const address = await listenLocal(server, { port: 0 });
  t.after(() => close(server));
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

test("client submits and polls a mock-web job", async (t) => {
  const { baseUrl } = await createTestService(t);
  const client = new Web2ApiClient({ baseUrl });

  assert.deepEqual(await client.health(), { ok: true });
  const providers = await client.listProviders();
  assert.equal(providers.some((provider) => provider.id === "mock-web"), true);

  const submitted = await client.submit({
    provider: "mock-web",
    input: [{ type: "text", text: "hello from client" }],
    output: { format: "markdown" },
    idempotencyKey: "client-test-001",
  });
  assert.match(submitted.id, /^[a-f0-9-]{36}$/u);

  const completed = await client.waitForTerminal(submitted.id, { timeoutMs: 2_000, intervalMs: 5 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.text, "# Mock web response\n\nMock provider received: hello from client\n");
  assert.equal(completed.output.format, "markdown");
  assert.equal((await client.getJob(submitted.id)).id, submitted.id);
});

test("client sends bearer authentication and exposes API errors", async (t) => {
  const { baseUrl } = await createTestService(t, "test-token");
  const unauthenticated = new Web2ApiClient({ baseUrl });
  await assert.rejects(
    () => unauthenticated.listProviders(),
    (error) => error instanceof Web2ApiClientError && error.code === "unauthorized" && error.status === 401,
  );

  const authenticated = new Web2ApiClient({ baseUrl, token: "test-token" });
  assert.equal((await authenticated.listProviders()).some((provider) => provider.id === "mock-web"), true);
});

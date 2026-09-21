import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWeb2ApiApp } from "../src/app.mjs";
import { browserCapabilities } from "../src/providers/provider.mjs";
import { createApiServer, listenLocal } from "../src/server.mjs";

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("local HTTP API advertises providers and completes a mock job", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "web2api-server-"));
  const { gateway } = await createWeb2ApiApp({ dataDirectory });
  const server = createApiServer({ gateway, token: "test-token" });
  const address = await listenLocal(server, { port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/providers`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const providers = await fetch(`${baseUrl}/v1/providers`, { headers });
    assert.equal(providers.status, 200);
    const providerList = await providers.json();
    assert.equal(providerList.data.some((provider) => provider.id === "mock-web"), true);

    const submitted = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "mock-web",
        input: [{ type: "text", text: "hello server" }],
        output: { format: "latex" },
      }),
    });
    assert.equal(submitted.status, 202);
    const job = await submitted.json();
    const completed = await gateway.waitForTerminal(job.id);
    assert.equal(completed.status, "completed");

    const fetched = await fetch(`${baseUrl}/v1/jobs/${job.id}`, { headers });
    assert.equal(fetched.status, 200);
    const fetchedJob = await fetched.json();
    assert.equal(fetchedJob.output.format, "latex");
    assert.equal(fetchedJob.output.text, "Mock provider received: hello server");

    const request = { provider: "mock-web", input: [{ type: "text", text: "first" }], idempotencyKey: "http-conflict" };
    const first = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(first.status, 202);
    await gateway.waitForTerminal((await first.json()).id);
    const conflict = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST", headers, body: JSON.stringify({ ...request, input: [{ type: "text", text: "different" }] }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "idempotency_conflict");
    const unknown = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST", headers, body: JSON.stringify({ ...request, conversationId: "unsupported" }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, "unsupported_feature");
  } finally {
    await close(server);
  }
});

test("local HTTP API serves retained text and downloadable files even when another artifact fails", async () => {
  const provider = {
    id: "artifact-web",
    displayName: "Artifact Web",
    capabilities: browserCapabilities({ artifacts: { downloadableFiles: true, generatedImages: true } }),
    async generate(_request, { jobDirectory }) {
      const sourcePath = path.join(jobDirectory, "provider-image.txt");
      await writeFile(sourcePath, "downloaded provider artifact", "utf8");
      return {
        text: "Artifact ready.",
        outputEnforcement: "provider_native_test",
        artifacts: [
          { sourcePath: path.join(jobDirectory, "missing.txt") },
          { sourcePath, fileName: "answer.txt", mediaType: "text/plain", originLabel: "provider download" },
        ],
      };
    },
  };
  const { gateway } = await createWeb2ApiApp({
    dataDirectory: await mkdtemp(path.join(os.tmpdir(), "web2api-download-")),
    providers: [provider],
  });
  const server = createApiServer({ gateway });
  const address = await listenLocal(server, { port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const submitted = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: provider.id, input: [{ type: "text", text: "create a file" }] }),
    });
    const job = await submitted.json();
    const finished = await gateway.waitForTerminal(job.id);
    assert.equal(finished.status, "failed");
    const fetched = await fetch(`${baseUrl}/v1/jobs/${job.id}`);
    const fetchedJob = await fetched.json();
    assert.equal(fetchedJob.output.text, "Artifact ready.");
    assert.equal(fetchedJob.error.code, "artifact_collection_failed");
    const artifact = finished.artifacts[0];
    const download = await fetch(`${baseUrl}${artifact.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain");
    assert.equal(await download.text(), "downloaded provider artifact");
  } finally {
    await close(server);
  }
});

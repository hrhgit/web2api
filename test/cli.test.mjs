import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileJobStore } from "../src/core/job-store.mjs";

test("provider inspection does not run startup recovery against a serving process's jobs", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "web2api-cli-test-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new FileJobStore(dataDirectory);
  await store.init();
  const id = "running-job-123";
  await store.create({ id, status: "running" });
  const before = await readFile(store.fileFor(id), "utf8");
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "providers"], {
    env: { ...process.env, WEB2API_DATA_DIR: dataDirectory },
  });
  const providers = JSON.parse(stdout);
  assert.deepEqual(providers.find((provider) => provider.id === "gemini-web").capabilities.output.formats, ["text", "markdown", "latex"]);
  const openai = providers.find((provider) => provider.id === "openai-web");
  assert.deepEqual(openai.capabilities.output.formats, ["text", "markdown", "latex"]);
  assert.equal(openai.capabilities.session, "persistent_local_profile");
  assert.equal(openai.capabilities.input.localFiles, false);
  assert.equal(openai.settings, undefined);
  const mock = providers.find((provider) => provider.id === "mock-web");
  assert.equal(mock.capabilities.input.localFiles, false);
  assert.equal(mock.capabilities.artifacts.downloadableFiles, false);
  assert.equal(await readFile(store.fileFor(id), "utf8"), before);
});

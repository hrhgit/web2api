import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repositoryDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryDirectory });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("npm pack dry-run contains only the public runtime package", async () => {
  const result = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  assert.equal(result.code, 0, result.stderr);
  const pack = JSON.parse(result.stdout);
  assert.equal(pack.length, 1);
  assert.equal(pack[0].id, "@ruihuahe/web2api@0.2.0");

  const files = new Set(pack[0].files.map((file) => file.path.replace(/^package\//u, "")));
  assert.equal(files.has("LICENSE"), true);
  assert.equal(files.has("README.md"), true);
  assert.equal(files.has("src/client.mjs"), true);
  assert.equal(files.has("package.json"), true);
  assert.equal([...files].some((file) => file.startsWith("test/")), false);
  assert.equal(files.has("AGENTS.md"), false);
  assert.equal(files.has("package-lock.json"), false);
});

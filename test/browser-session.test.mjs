import assert from "node:assert/strict";
import test from "node:test";
import { closeBrowser, waitForProfileRelease } from "../src/providers/browser-session.mjs";

function slowContext(ms, log, name) {
  return {
    close: () => new Promise((resolve) => setTimeout(() => { log.push(`closed ${name}`); resolve(); }, ms)),
  };
}

test("closeBrowser returns immediately and profile release waits for the close", async () => {
  const log = [];
  const settings = { profileDirectory: "/tmp/web2api-test-profile-a" };
  const started = Date.now();
  closeBrowser(slowContext(80, log, "first"), settings);
  assert.ok(Date.now() - started < 20, "closeBrowser must not block");
  assert.deepEqual(log, []);
  await waitForProfileRelease(settings);
  assert.deepEqual(log, ["closed first"]);
});

test("closes of one profile run in order and other profiles are not delayed", async () => {
  const log = [];
  const a = { profileDirectory: "/tmp/web2api-test-profile-b" };
  const b = { profileDirectory: "/tmp/web2api-test-profile-c" };
  closeBrowser(slowContext(60, log, "a1"), a);
  closeBrowser(slowContext(10, log, "a2"), a);
  const startedB = Date.now();
  await waitForProfileRelease(b);
  assert.ok(Date.now() - startedB < 20, "an unrelated profile is released immediately");
  await waitForProfileRelease(a);
  assert.deepEqual(log, ["closed a1", "closed a2"]);
});

test("a failing close still releases the profile", async () => {
  const settings = { profileDirectory: "/tmp/web2api-test-profile-d" };
  closeBrowser({ close: () => Promise.reject(new Error("boom")) }, settings);
  await waitForProfileRelease(settings);
});

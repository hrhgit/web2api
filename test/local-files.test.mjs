import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachGeminiFile, attachmentNames } from "../src/providers/local-files.mjs";

test("attachment names account for extension-less labels", () => {
  assert.deepEqual(attachmentNames("/audio/chunk-0001.m4a"), ["chunk-0001.m4a", "chunk-0001"]);
});

test("a failed or delayed native drop is never followed by a duplicate menu upload", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web2api-drop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "audio.m4a");
  await writeFile(file, "fixture");
  for (const failure of ["drop", "confirmation"]) {
    const events = [];
    let menus = 0;
    const page = {
      locator: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => true, boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }) }) }),
      context: () => ({ newCDPSession: async () => ({ send: async (_method, { type }) => {
        events.push(type); if (failure === "drop" && type === "drop") throw new Error("drop uncertain");
      }, detach: async () => {} }) }),
      waitForFunction: async () => { throw new Error("confirmation timed out"); },
      getByRole: () => { menus++; throw new Error("must not upload twice"); },
    };
    await assert.rejects(attachGeminiFile(page, file), /drop uncertain|confirmation timed out/);
    assert.deepEqual(events, ["dragEnter", "dragOver", "drop"]);
    assert.equal(menus, 0);
  }
});

test("upload diagnostics record the page state around a native drop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web2api-upload-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "chunk-0001.m4a");
  await writeFile(file, "fixture");
  const events = [];
  const page = {
    locator: () => ({
      count: async () => 1,
      nth: () => ({ isVisible: async () => true, boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }) }),
    }),
    evaluate: async () => ({
      url: "https://gemini.google.com/app/test",
      title: "Gemini",
      expectedNames: ["chunk-0001.m4a", "chunk-0001"],
      bodyContainsExpectedName: true,
      dropTargets: [{ visible: true, width: 100, height: 40 }],
      uploadButtons: [{ label: "Upload & tools", visible: true }],
      fileInputs: [{ visible: false, accept: "audio/*" }],
      attachments: [{ label: "chunk-0001.m4a", visible: true }],
      editors: [{ visible: true }],
      userMessages: 0,
      modelResponses: 0,
    }),
    context: () => ({ newCDPSession: async () => ({
      send: async () => {},
      detach: async () => {},
    }) }),
    waitForFunction: async () => {},
  };

  await attachGeminiFile(page, file, { log: (event, details) => events.push({ event, details }) });

  assert.equal(events[0].event, "gemini_upload_started");
  assert.deepEqual(
    events.filter((entry) => entry.event === "gemini_upload_page_state").map((entry) => entry.details.phase),
    ["before-native-drop", "before-attachment-confirmation", "attachment-confirmed"],
  );
  assert.ok(events.some((entry) => entry.event === "gemini_upload_native_drop_target"));
  assert.ok(events.some((entry) => entry.event === "gemini_upload_confirmed" && entry.details.method === "native-drag"));
});

test("the menu upload path skips native drag when explicitly selected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web2api-menu-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "chunk-0001.m4a");
  await writeFile(file, "fixture");
  const events = [];
  const page = {
    evaluate: async () => ({
      url: "https://gemini.google.com/app/test",
      title: "Gemini",
      expectedNames: ["chunk-0001.m4a", "chunk-0001"],
      bodyContainsExpectedName: true,
      dropTargets: [{ visible: true, width: 100, height: 40 }],
      uploadButtons: [{ label: "Upload & tools", visible: true }],
      fileInputs: [{ visible: false, accept: "audio/*" }],
      attachments: [{ label: "chunk-0001.m4a", visible: true }],
      editors: [{ visible: true }],
      userMessages: 0,
      modelResponses: 0,
    }),
    locator: (selector) => {
      if (selector !== 'button[aria-label="Upload files. Documents, data, code files"]') {
        throw new Error(`native drag should not inspect ${selector}`);
      }
      return { click: async () => events.push("file-button-clicked") };
    },
    getByRole: (_role, options) => {
      assert.equal(options.name, "Upload & tools");
      return { click: async () => events.push("upload-menu-opened") };
    },
    waitForEvent: async (event) => {
      assert.equal(event, "filechooser");
      return { setFiles: async () => events.push("file-selected") };
    },
    waitForFunction: async () => {},
  };

  await attachGeminiFile(page, file, { uploadMethod: "menu" });

  assert.deepEqual(events, ["upload-menu-opened", "file-button-clicked", "file-selected"]);
});

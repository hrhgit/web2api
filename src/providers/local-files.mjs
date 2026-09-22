import path from "node:path";
import { stat } from "node:fs/promises";
import { ProviderError } from "./provider.mjs";
import { summarizeError } from "./diagnostics.mjs";

export function attachmentNames(filePath) {
  const name = path.basename(filePath);
  return [...new Set([name, path.basename(name, path.extname(name))].filter(Boolean))];
}

export async function inspectGeminiUploadPage(page, expectedPaths = []) {
  const expectedNames = [...new Set(expectedPaths.flatMap(attachmentNames))];
  return page.evaluate((names) => {
    const visibleNode = (node) => node.getClientRects().length > 0;
    const bounds = (node) => {
      const rect = node.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const labeledButtons = [...document.querySelectorAll("button")]
      .map((node) => ({
        label: node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "",
        visible: visibleNode(node),
      }))
      .filter((button) => /upload|send|submit|attach/iu.test(button.label));
    const attachments = [...document.querySelectorAll('[data-test-id="uploaded-file"], user-query-file-preview')]
      .map((node) => ({
        label: `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.trim(),
        visible: visibleNode(node),
      }));
    const dropTargets = [...document.querySelectorAll("input-area-v2")]
      .map((node) => ({ visible: visibleNode(node), ...bounds(node) }));
    const editors = [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')]
      .map((node) => ({ visible: visibleNode(node) }));
    const userMessages = document.querySelectorAll('user-query, [data-message-author-role="user"]').length;
    const modelResponses = document.querySelectorAll('model-response, [data-message-author-role="model"]').length;
    return {
      url: location.href,
      title: document.title,
      expectedNames: names,
      bodyContainsExpectedName: names.some((name) => (document.body?.innerText || "").includes(name)),
      dropTargets,
      uploadButtons: labeledButtons,
      fileInputs: [...document.querySelectorAll('input[type="file"]')].map((node) => ({
        visible: visibleNode(node),
        accept: node.getAttribute("accept") || "",
      })),
      attachments,
      editors,
      userMessages,
      modelResponses,
    };
  }, expectedNames);
}

async function logUploadPageState(page, expectedPaths, log, phase, details = {}) {
  if (!log) return;
  try {
    log("gemini_upload_page_state", {
      phase,
      ...await inspectGeminiUploadPage(page, expectedPaths),
      ...details,
    });
  } catch (error) {
    log("gemini_upload_page_state_unavailable", {
      phase,
      expectedNames: [...new Set(expectedPaths.flatMap(attachmentNames))],
      error: summarizeError(error),
      ...details,
    });
  }
}

async function waitForAttachment(page, filePath, { log = null, method = null } = {}) {
  await logUploadPageState(page, [filePath], log, "before-attachment-confirmation", { method });
  await page.waitForFunction((names) => names.some((name) => (document.body?.innerText || "").includes(name)),
    attachmentNames(filePath), { timeout: 60_000, polling: 250 });
  await logUploadPageState(page, [filePath], log, "attachment-confirmed", { method });
}

async function nativeDrop(page, filePath, { log = null } = {}) {
  const targets = page.locator("input-area-v2");
  await logUploadPageState(page, [filePath], log, "before-native-drop");
  let box;
  let targetIndex = -1;
  for (let n = 0; n < await targets.count(); n++) {
    if (await targets.nth(n).isVisible()) { targetIndex = n; box = await targets.nth(n).boundingBox(); break; }
  }
  if (!box || box.width <= 0 || box.height <= 0) {
    log?.("gemini_upload_native_drop_unavailable", { reason: "no_visible_drop_target", targetIndex });
    return false;
  }
  log?.("gemini_upload_native_drop_target", {
    targetIndex,
    width: Math.round(box.width),
    height: Math.round(box.height),
  });
  let cdp;
  try { cdp = await page.context().newCDPSession(page); }
  catch (error) {
    log?.("gemini_upload_native_drop_unavailable", { reason: "cdp_session_unavailable", error: summarizeError(error) });
    return false;
  }
  try {
    const params = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2),
      data: { items: [], files: [filePath], dragOperationsMask: 1 } };
    try {
      log?.("gemini_upload_native_drop_dispatch", { type: "dragEnter", x: params.x, y: params.y });
      await cdp.send("Input.dispatchDragEvent", { ...params, type: "dragEnter" });
      log?.("gemini_upload_native_drop_dispatch", { type: "dragOver", x: params.x, y: params.y });
      await cdp.send("Input.dispatchDragEvent", { ...params, type: "dragOver" });
    } catch (error) {
      log?.("gemini_upload_native_drop_unavailable", { reason: "drag_target_rejected", error: summarizeError(error) });
      return false;
    }
    // Once drop is attempted, never fall back to a second upload.
    log?.("gemini_upload_native_drop_dispatch", { type: "drop", x: params.x, y: params.y });
    await cdp.send("Input.dispatchDragEvent", { ...params, type: "drop" });
    await waitForAttachment(page, filePath, { log, method: "native-drag" });
    return true;
  } finally { await cdp.detach().catch(() => {}); }
}

export async function attachGeminiFile(page, filePath, { log = null, uploadMethod = "auto" } = {}) {
  let fileStats;
  try { fileStats = await stat(filePath); }
  catch (error) { throw new ProviderError("attachment_missing", "The requested local attachment does not exist.", { cause: error }); }
  if (!fileStats.isFile()) throw new ProviderError("attachment_invalid", "The requested local attachment is not a regular file.");
  if (!["auto", "native", "menu"].includes(uploadMethod)) {
    throw new ProviderError("attachment_method_invalid", "The requested Gemini attachment method is not supported.");
  }
  log?.("gemini_upload_started", { fileName: path.basename(filePath), bytes: fileStats.size });
  if (uploadMethod !== "menu" && await nativeDrop(page, filePath, { log })) {
    log?.("gemini_upload_confirmed", { fileName: path.basename(filePath), method: "native-drag" });
    return;
  }
  if (uploadMethod === "native") {
    throw new ProviderError("attachment_upload_failed", "Gemini's native attachment drop did not confirm the file.");
  }
  await logUploadPageState(page, [filePath], log, "before-menu-upload");
  await page.getByRole("button", { name: "Upload & tools", exact: true }).click({ timeout: 30_000 });
  log?.("gemini_upload_menu_opened", { fileName: path.basename(filePath) });
  const upload = page.locator('button[aria-label="Upload files. Documents, data, code files"]');
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15_000 }), upload.click({ timeout: 15_000 }),
  ]);
  log?.("gemini_upload_filechooser_ready", { fileName: path.basename(filePath) });
  await chooser.setFiles(filePath);
  await waitForAttachment(page, filePath, { log, method: "upload-menu" });
  log?.("gemini_upload_confirmed", { fileName: path.basename(filePath), method: "upload-menu" });
}

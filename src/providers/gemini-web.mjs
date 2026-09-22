import os from "node:os";
import { assertConversationPage, conversationAddress, waitForConversationIdle } from "./conversation.mjs";
import path from "node:path";
import { BrowserPagePool, launchBrowser } from "./browser-session.mjs";
import { browserCapabilities, ProviderError } from "./provider.mjs";
import { extractResponseText } from "./extract-response.mjs";
import { attachGeminiFile, attachmentNames, inspectGeminiUploadPage } from "./local-files.mjs";
import { createUploadDebugLogger, summarizeError } from "./diagnostics.mjs";

const GEMINI_URL = "https://gemini.google.com/app";
const PROMPT_SELECTOR = '[role="textbox"][contenteditable="true"]';
const ACCOUNT_SELECTOR = 'a[href*="accounts.google.com/SignOutOptions"], a[aria-label^="Google Account:"]';
const SIGN_IN_SELECTOR = 'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"]';
const USER_QUERY_SELECTOR = 'user-query, [data-message-author-role="user"]';
const MODEL_RESPONSE_SELECTOR = 'model-response, [data-message-author-role="model"]';

function normalizeText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function defaultProfileDirectory() {
  return path.join(os.homedir(), ".web2api", "profiles", "gemini");
}

function composePrompt(request) {
  return request.input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

async function isLoggedIn(page) {
  return page.locator(ACCOUNT_SELECTOR).evaluateAll((nodes) =>
    nodes.some((node) => node.getClientRects().length > 0),
  );
}

async function waitForLogin(page, timeoutMs) {
  const ready = await page.waitForFunction(
    ({ account, prompt }) => {
      if (location.hostname !== "gemini.google.com") return false;
      const visible = (node) => node.getClientRects().length > 0;
      return [...document.querySelectorAll(account)].some(visible) &&
        [...document.querySelectorAll(prompt)].some(visible);
    },
    { account: ACCOUNT_SELECTOR, prompt: PROMPT_SELECTOR },
    { timeout: timeoutMs, polling: 500 },
  );
  await ready.dispose();
}

async function waitForGeminiReady(page, timeoutMs) {
  const ready = await page.waitForFunction(
    ({ account, signIn, prompt }) => {
      const visible = (node) => node.getClientRects().length > 0;
      const accountVisible = [...document.querySelectorAll(account)].some(visible);
      const signInVisible = [...document.querySelectorAll(`${signIn}, button, a`)].some((node) => {
        if (!visible(node)) return false;
        const text = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.trim();
        return /^(sign in|登录)/iu.test(text) || node.matches(signIn);
      });
      if (location.hostname === "accounts.google.com" || signInVisible) return "login_required";
      return accountVisible && [...document.querySelectorAll(prompt)].some(visible) ? "ready" : false;
    },
    { account: ACCOUNT_SELECTOR, signIn: SIGN_IN_SELECTOR, prompt: PROMPT_SELECTOR },
    { timeout: timeoutMs, polling: 500 },
  );
  await ready.dispose();
  if (!(await isLoggedIn(page))) {
    throw new ProviderError("needs_login", "Gemini login is required in web2api's dedicated browser profile.");
  }
  await page.locator(PROMPT_SELECTOR).waitFor({ state: "visible", timeout: timeoutMs });
}

async function submittedMessages(page) {
  return page.locator(USER_QUERY_SELECTOR).evaluateAll((nodes) => nodes.map((node) => {
    const lines = [...node.querySelectorAll(".query-text-line")];
    return lines.length ? lines.map((line) => line.textContent || "").join("\n") : node.textContent || "";
  }));
}

async function getModelState(page, format) {
  const state = await page.evaluate((responseSelector) => {
    const nodes = [...document.querySelectorAll(responseSelector)];
    const latest = nodes.at(-1);
    const contentSelector = ["message-content", ".model-response-text"].find((selector) => latest?.querySelector(selector));
    const buttons = [...document.querySelectorAll("button")].filter((node) => node.getClientRects().length > 0);
    const busy = buttons.some((button) => /stop response|stop generating|停止回复|停止生成/iu.test(
      `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`,
    ));
    // Only inspect visible UI notifications, never the user's prompt or model prose.
    const errorText = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" &&
        !node.closest('user-query, message-content, .model-response-text, [data-message-author-role], [role="textbox"]'))
      .map((node) => node.innerText || "")
      .join("\n").toLowerCase();
    const visibleError = [
      "Something went wrong", "An error occurred", "You have reached your limit",
      "出了点问题", "发生错误", "已达到上限",
    ].find((message) => errorText.includes(message.toLowerCase()));
    return { count: nodes.length, contentSelector, busy, visibleError: visibleError || null };
  }, MODEL_RESPONSE_SELECTOR);
  if (!state.count || state.visibleError) return { ...state, text: "" };
  const response = page.locator(MODEL_RESPONSE_SELECTOR).last();
  const content = state.contentSelector ? response.locator(state.contentSelector).first() : response;
  return { ...state, ...await content.evaluate(extractResponseText, { format }) };
}

async function waitForModelResponse(page, baseline, { timeoutMs, signal, format, log = null }) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableSince = 0;
  let responseLogged = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error("Job aborted.");
    const state = await getModelState(page, format);
    if (state.visibleError) {
      log?.("gemini_response_ui_error", { error: state.visibleError, responseCount: state.count });
      throw new ProviderError("provider_ui_error", `Gemini displayed an error: ${state.visibleError}`);
    }
    const isNewResponse = state.count > baseline.count || (state.text && state.text !== baseline.text);
    if (isNewResponse && state.text) {
      if (!responseLogged) {
        responseLogged = true;
        log?.("gemini_response_detected", {
          responseCount: state.count,
          busy: state.busy,
          textCharacters: state.text.length,
          extraction: state.extraction,
        });
      }
      if (state.text === lastText && !state.busy) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 2_500) {
          log?.("gemini_response_stable", {
            responseCount: state.count,
            textCharacters: state.text.length,
            extraction: state.extraction,
          });
          return state;
        }
      } else {
        lastText = state.text;
        stableSince = state.busy ? 0 : Date.now();
      }
    }
    await page.waitForTimeout(750);
  }
  throw new ProviderError("response_timeout", `Gemini did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}

export class GeminiWebProvider {
  constructor(options = {}) {
    this.id = "gemini-web";
    this.displayName = "Gemini Web";
    this.capabilities = browserCapabilities({
      localFiles: true,
      nativeConversations: true,
      outputFormats: ["text", "markdown", "latex"],
      login: "persistent_local_profile",
      artifacts: { downloadableFiles: false, generatedImages: false },
      readinessCheck: true,
      runningCancellation: true,
      submissionTracking: true,
      maxConcurrency: Number(options.maxConcurrency ?? process.env.WEB2API_GEMINI_CONCURRENCY ?? 3),
    });
    this.settings = {
      profileDirectory: path.resolve(options.profileDirectory || process.env.WEB2API_GEMINI_PROFILE_DIR || defaultProfileDirectory()),
      profileName: options.profileName || process.env.WEB2API_GEMINI_PROFILE_NAME || "Default",
      channel: options.channel || process.env.WEB2API_BROWSER_CHANNEL || "chrome",
      executablePath: options.executablePath || process.env.WEB2API_BROWSER_EXECUTABLE || null,
    };
    const attachmentSettleMs = Number(options.attachmentSettleMs ?? process.env.WEB2API_GEMINI_ATTACHMENT_SETTLE_MS ?? 2_000);
    this.attachmentSettleMs = Number.isFinite(attachmentSettleMs) ? Math.max(0, Math.min(30_000, attachmentSettleMs)) : 0;
    this.uploadMethod = options.uploadMethod ?? process.env.WEB2API_GEMINI_UPLOAD_METHOD ?? "menu";
    this.pool = new BrowserPagePool(this.settings, { displayName: this.displayName });
    this.uploadLog = options.log ?? createUploadDebugLogger();
  }

  async check({ timeoutMs = 30_000 } = {}) {
    const { context, page } = await launchBrowser(this.settings, { displayName: this.displayName });
    try {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await waitForGeminiReady(page, timeoutMs);
    } finally { await context.close(); }
  }

  async login({ timeoutMs = 15 * 60_000 } = {}) {
    const { context, page } = await launchBrowser(this.settings, { headed: true, displayName: this.displayName });
    try {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
      await waitForLogin(page, timeoutMs);
      return { provider: this.id, status: "ready" };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async generate(request, { jobId = null, signal, conversationUrl = null, reportSubmission = async () => {} } = {}) {
    signal?.throwIfAborted();
    const { page, release } = await this.pool.acquire();
    const log = (event, details = {}) => this.uploadLog?.(event, { provider: this.id, jobId, ...details });
    const uploadLog = this.uploadLog ? log : null;
    const closeOnAbort = () => { void page.close().catch(() => {}); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (signal?.aborted) throw signal.reason || new Error("Job aborted.");
      log("gemini_generation_started", {
        input: request.input.map((item) => item.type === "text"
          ? { type: "text", characters: item.text.length }
          : { type: "local_file", fileName: path.basename(item.path) }),
        outputFormat: request.output.format,
        timeoutMs: request.timeoutMs,
      });
      await page.goto(conversationUrl ? conversationAddress(conversationUrl, this.id) : GEMINI_URL, { waitUntil: "domcontentloaded", timeout: Math.min(request.timeoutMs, 60_000) });
      await waitForGeminiReady(page, Math.min(request.timeoutMs, 60_000));
      if (conversationUrl) await waitForConversationIdle(page, {
        address: conversationUrl, provider: this.id, state: () => getModelState(page, request.output.format),
        userSelector: USER_QUERY_SELECTOR, timeoutMs: Math.min(request.timeoutMs, 60_000), signal,
      });
      log("gemini_page_ready", { url: page.url(), title: await page.title().catch(() => null) });
      const format = request.output.format;
      const baseline = await getModelState(page, format);
      if (request.conversationId && !conversationUrl && (baseline.count || await page.locator(USER_QUERY_SELECTOR).count())) {
        throw new ProviderError("conversation_unavailable", "A fresh conversation could not be established. No prompt was sent.");
      }
      log("gemini_before_upload", {
        url: page.url(),
        responseCount: baseline.count,
        composerReady: Boolean(await page.locator(PROMPT_SELECTOR).count()),
      });
      for (const item of request.input) {
        if (item.type === "local_file") {
          await attachGeminiFile(page, item.path, { log: uploadLog, uploadMethod: this.uploadMethod });
        }
      }
      if (uploadLog) {
        log("gemini_after_upload", {
          ...(await inspectGeminiUploadPage(page, request.input.filter((item) => item.type === "local_file").map((item) => item.path))),
        });
      }
      if (this.attachmentSettleMs > 0 && request.input.some((item) => item.type === "local_file")) {
        log("gemini_attachment_settle_started", { milliseconds: this.attachmentSettleMs });
        await page.waitForTimeout(this.attachmentSettleMs);
        log("gemini_attachment_settle_finished", { milliseconds: this.attachmentSettleMs });
      }
      const prompt = composePrompt(request);
      const previousMessages = await submittedMessages(page);
      const editor = page.locator(PROMPT_SELECTOR);
      await editor.fill(prompt);
      if (normalizeText(await editor.innerText()) !== normalizeText(prompt)) {
        throw new ProviderError("composer_mismatch", "Gemini's composer did not retain the submitted prompt.");
      }
      const send = page.getByRole("button", { name: /^(send|send message|submit|发送|发送消息)$/iu });
      signal?.throwIfAborted();
      log("gemini_before_submit", { url: page.url(), userMessageCount: previousMessages.length });
      if (conversationUrl) {
        assertConversationPage(page, conversationUrl, this.id);
        const state = await getModelState(page, format);
        if (state.busy || state.count !== baseline.count || state.text !== baseline.text || (await submittedMessages(page)).length !== previousMessages.length) {
          throw new ProviderError("conversation_busy", "Conversation changed before submission. No follow-up was sent.");
        }
      }
      await reportSubmission("unknown");
      await send.click({ timeout: 120_000 });
      log("gemini_send_clicked", { url: page.url() });
      await page.waitForFunction(
        ({ selector, previousCount, expected, attachments }) => {
          const nodes = [...document.querySelectorAll(selector)];
          if (nodes.length <= previousCount) return false;
          const node = nodes.at(-1);
          const lines = [...node.querySelectorAll(".query-text-line")];
          const text = (lines.length ? lines.map((line) => line.textContent).join("\n") : node.textContent || "")
            .replace(/\s+/gu, " ").trim();
          const submittedFiles = [...node.querySelectorAll('[data-test-id="uploaded-file"], user-query-file-preview')]
            .map((file) => `${file.getAttribute("aria-label") || ""} ${file.textContent || ""}`);
          return text === expected && attachments.every((names) => submittedFiles.some((label) => names.some((name) => label.includes(name))));
        },
        { selector: USER_QUERY_SELECTOR, previousCount: previousMessages.length, expected: normalizeText(prompt),
          attachments: request.input.filter((item) => item.type === "local_file").map((item) => attachmentNames(item.path)) },
        { timeout: 30_000, polling: 250 },
      ).catch((error) => {
        throw new ProviderError("submission_unconfirmed", "Gemini did not confirm the submitted prompt; web2api will not send a duplicate request.", { cause: error });
      });
      await reportSubmission("confirmed");
      log("gemini_submission_confirmed", {
        url: page.url(),
        userMessageCount: await page.locator(USER_QUERY_SELECTOR).count(),
        attachmentNames: request.input.filter((item) => item.type === "local_file").map((item) => attachmentNames(item.path)),
      });
      const response = await waitForModelResponse(page, baseline, { timeoutMs: request.timeoutMs, signal, format, log });
      if (conversationUrl) assertConversationPage(page, conversationUrl, this.id);
      if (request.conversationId) conversationAddress(page.url(), this.id);
      return {
        text: response.text,
        outputEnforcement: "dom_extraction",
        artifacts: [],
        providerMetadata: { conversationUrl: page.url(), extraction: response.extraction },
      };
    } catch (error) {
      log("gemini_generation_failed", { url: page.url(), error: summarizeError(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      await release();
    }
  }
}

import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./browser-session.mjs";
import { browserCapabilities, ProviderError } from "./provider.mjs";
import { extractResponseText } from "./extract-response.mjs";

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

async function waitForModelResponse(page, baseline, { timeoutMs, signal, format }) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error("Job aborted.");
    const state = await getModelState(page, format);
    if (state.visibleError) throw new ProviderError("provider_ui_error", `Gemini displayed an error: ${state.visibleError}`);
    const isNewResponse = state.count > baseline.count || (state.text && state.text !== baseline.text);
    if (isNewResponse && state.text) {
      if (state.text === lastText && !state.busy) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 2_500) return state;
      } else {
        lastText = state.text;
        stableSince = state.busy ? 0 : Date.now();
      }
    }
    await page.waitForTimeout(750);
  }
  throw new ProviderError("response_timeout", `Gemini did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function waitForAttachment(page, filePath) {
  const fileName = path.basename(filePath);
  await page.waitForFunction(
    (name) => (document.body?.innerText || "").includes(name),
    fileName,
    { timeout: 60_000, polling: 500 },
  );
}

async function attachLocalFile(page, filePath) {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    throw new ProviderError("attachment_missing", `Attachment does not exist: ${filePath}`, { cause: error });
  }
  if (!fileStats.isFile()) {
    throw new ProviderError("attachment_invalid", `Attachment is not a regular file: ${filePath}`);
  }
  const uploadTools = page.getByRole("button", { name: "Upload & tools", exact: true });
  await uploadTools.click({ timeout: 30_000 });
  const upload = page.locator('button[aria-label="Upload files. Documents, data, code files"]');
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15_000 }),
    upload.click({ timeout: 15_000 }),
  ]);
  await chooser.setFiles(filePath);
  await waitForAttachment(page, filePath);
}

export class GeminiWebProvider {
  constructor(options = {}) {
    this.id = "gemini-web";
    this.displayName = "Gemini Web";
    this.capabilities = browserCapabilities({
      localFiles: true,
      outputFormats: ["text", "markdown", "latex"],
      login: "persistent_local_profile",
      artifacts: { downloadableFiles: false, generatedImages: false },
    });
    this.settings = {
      profileDirectory: path.resolve(options.profileDirectory || process.env.WEB2API_GEMINI_PROFILE_DIR || defaultProfileDirectory()),
      profileName: options.profileName || process.env.WEB2API_GEMINI_PROFILE_NAME || "Default",
      channel: options.channel || process.env.WEB2API_BROWSER_CHANNEL || "chrome",
      executablePath: options.executablePath || process.env.WEB2API_BROWSER_EXECUTABLE || null,
    };
  }

  async login({ timeoutMs = 15 * 60_000 } = {}) {
    const { context, page } = await launchBrowser(this.settings, { headed: true, displayName: this.displayName });
    try {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
      await waitForLogin(page, timeoutMs);
      return { provider: this.id, profileDirectory: this.settings.profileDirectory, profileName: this.settings.profileName };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async generate(request, { signal } = {}) {
    const { context, page } = await launchBrowser(this.settings, { displayName: this.displayName });
    const closeOnAbort = () => { void context.close().catch(() => {}); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (signal?.aborted) throw signal.reason || new Error("Job aborted.");
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
      await waitForGeminiReady(page, Math.min(request.timeoutMs, 60_000));
      const format = request.output.format;
      const baseline = await getModelState(page, format);
      for (const item of request.input) {
        if (item.type === "local_file") await attachLocalFile(page, item.path);
      }
      const prompt = composePrompt(request);
      const previousMessages = await submittedMessages(page);
      const editor = page.locator(PROMPT_SELECTOR);
      await editor.fill(prompt);
      if (normalizeText(await editor.innerText()) !== normalizeText(prompt)) {
        throw new ProviderError("composer_mismatch", "Gemini's composer did not retain the submitted prompt.");
      }
      const send = page.getByRole("button", { name: /^(send|send message|submit|发送|发送消息)$/iu });
      await send.click({ timeout: 120_000 });
      await page.waitForFunction(
        ({ selector, previousCount, expected }) => {
          const nodes = [...document.querySelectorAll(selector)];
          if (nodes.length <= previousCount) return false;
          const node = nodes.at(-1);
          const lines = [...node.querySelectorAll(".query-text-line")];
          const text = (lines.length ? lines.map((line) => line.textContent).join("\n") : node.textContent || "")
            .replace(/\s+/gu, " ").trim();
          return text === expected;
        },
        { selector: USER_QUERY_SELECTOR, previousCount: previousMessages.length, expected: normalizeText(prompt) },
        { timeout: 30_000, polling: 250 },
      ).catch((error) => {
        throw new ProviderError("submission_unconfirmed", "Gemini did not confirm the submitted prompt; web2api will not send a duplicate request.", { cause: error });
      });
      const response = await waitForModelResponse(page, baseline, { timeoutMs: request.timeoutMs, signal, format });
      return {
        text: response.text,
        outputEnforcement: "dom_extraction",
        artifacts: [],
        providerMetadata: { conversationUrl: page.url(), extraction: response.extraction },
      };
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => {});
    }
  }
}

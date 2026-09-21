import os from "node:os";
import path from "node:path";
import { assertProviderSupportsRequest } from "../core/contracts.mjs";
import { launchBrowser } from "./browser-session.mjs";
import { extractResponseText } from "./extract-response.mjs";
import { browserCapabilities, ProviderError } from "./provider.mjs";

const CHATGPT_URL = "https://chatgpt.com/";
const SELECTORS = {
  prompt: '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea',
  account: '[data-testid="accounts-profile-button"], [data-testid="profile-button"], button[aria-label="Open profile menu"]',
  login: '[data-testid="login-button"], a[href="/auth/login"]',
  send: 'button[data-testid="send-button"]',
  stop: 'button[data-testid="stop-button"]',
  user: '[data-message-author-role="user"]',
  assistant: '[data-message-author-role="assistant"]',
  chatMode: '[role="radio"][data-tpp-toggle-value="chatgpt"]',
  workMode: '[role="radio"][data-tpp-toggle-value="work"]',
};

function normalizeText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function chatModeSelected(selectors) {
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const chat = [...document.querySelectorAll(selectors.chatMode)].filter(visible);
  const work = [...document.querySelectorAll(selectors.workMode)].filter(visible);
  return chat.length === 1 && chat[0].getAttribute("aria-checked") === "true" &&
    !work.some((node) => node.getAttribute("aria-checked") === "true");
}

async function ensureChatMode(page, timeoutMs) {
  try {
    const chat = page.locator(SELECTORS.chatMode).filter({ visible: true });
    await chat.waitFor({ state: "visible", timeout: timeoutMs });
    if (!(await page.evaluate(chatModeSelected, SELECTORS))) await chat.click({ timeout: timeoutMs });
    const confirmed = await page.waitForFunction(chatModeSelected, SELECTORS, { timeout: timeoutMs, polling: 100 });
    await confirmed.dispose();
    await page.locator(SELECTORS.prompt).waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    throw new ProviderError("chat_mode_unavailable", "ChatGPT's Chat mode could not be confirmed. No prompt was submitted.", { cause: error });
  }
}

async function waitForReady(page, timeoutMs, { interactive = false } = {}) {
  let handle;
  try {
    handle = await page.waitForFunction(({ selectors, interactive }) => {
      const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
      const has = (selector) => [...document.querySelectorAll(selector)].some(visible);
      const onSite = location.hostname === "chatgpt.com";
      if (onSite && has(selectors.account) && has(selectors.prompt)) return "ready";
      if (interactive) return false;
      if (!onSite || has(selectors.login) || [...document.querySelectorAll("button, a")].some((node) =>
        visible(node) && /^(log in|sign in|登录)$/iu.test((node.textContent || "").trim()))) return "needs_login";
      if (/^(Just a moment|Attention Required)/iu.test(document.title) ||
        has('#challenge-stage, #challenge-running, iframe[src*="challenges.cloudflare.com"]')) return "browser_verification_required";
      return false;
    }, { selectors: SELECTORS, interactive }, { timeout: timeoutMs, polling: 500 });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new ProviderError(interactive ? "login_timeout" : "page_not_ready", interactive
      ? "ChatGPT login did not finish before the login timeout."
      : "ChatGPT's signed-in composer did not become ready.", { cause: error });
  }
  const state = await handle.jsonValue();
  await handle.dispose();
  if (state === "needs_login") throw new ProviderError("needs_login", "ChatGPT login is required in web2api's dedicated browser profile. Run web2api login openai-web.");
  if (state === "browser_verification_required") throw new ProviderError(state, "ChatGPT's browser verification blocked this request before submission. Manual login may not allow automated access.");
}

async function responseState(page, format) {
  const state = await page.evaluate((selectors) => {
    const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const messages = [...document.querySelectorAll(selectors.assistant)];
    const latest = messages.at(-1);
    const turn = latest?.closest('article, [data-testid^="conversation-turn-"]') || latest?.parentElement;
    const busy = [...document.querySelectorAll(selectors.stop)].some(visible) ||
      !!latest?.matches('[data-is-streaming="true"]') || !!latest?.querySelector(".result-streaming");
    const complete = !!turn?.querySelector('[data-testid="copy-turn-action-button"]');
    const notifications = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
      .filter((node) => visible(node) && !node.closest('[data-message-author-role], #prompt-textarea'))
      .map((node) => node.innerText || "").join("\n");
    const error = /too many requests|(?:reached|hit) .{0,40}limit|usage limit|已达到.{0,20}上限/iu.test(notifications)
      ? "rate_limited" : /something went wrong|an error occurred|unable to (?:generate|load)|出了点问题|发生错误/iu.test(notifications)
        ? "provider_ui_error" : null;
    const needsLogin = location.hostname !== "chatgpt.com" || [...document.querySelectorAll(selectors.login)].some(visible);
    const challenge = /^(Just a moment|Attention Required)/iu.test(document.title);
    return { count: messages.length, busy, complete, error, needsLogin, challenge, hasMarkdown: !!latest?.querySelector(".markdown") };
  }, SELECTORS);
  if (!state.count || state.error || state.needsLogin || state.challenge) return { ...state, text: "" };
  const response = page.locator(SELECTORS.assistant).last();
  // ChatGPT keeps turn controls and speaker labels outside its Markdown body.
  // A message may contain multiple bodies; preserve their DOM order.
  const bodies = state.hasMarkdown ? response.locator(".markdown") : response;
  const parts = [];
  for (let index = 0; index < await bodies.count(); index++) {
    parts.push(await bodies.nth(index).evaluate(extractResponseText, { format }));
  }
  return {
    ...state,
    text: parts.map((part) => part.text).filter(Boolean).join("\n\n"),
    extraction: {
      source: "response_dom",
      math: parts.reduce((total, part) => ({ source: total.source + part.extraction.math.source, rendered: total.rendered + part.extraction.math.rendered }), { source: 0, rendered: 0 }),
    },
  };
}

async function waitForResponse(page, baselineCount, { timeoutMs, signal, format }) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const state = await responseState(page, format);
    if (state.needsLogin) throw new ProviderError("needs_login", "ChatGPT's browser session expired while waiting for the response.");
    if (state.challenge) throw new ProviderError("browser_verification_required", "ChatGPT requires verification in its dedicated browser profile.");
    if (state.error) throw new ProviderError(state.error, state.error === "rate_limited"
      ? "ChatGPT displayed a usage limit notification." : "ChatGPT displayed an error notification.");
    if (state.count > baselineCount && state.text && state.complete && !state.busy) {
      if (lastText === state.text && stableSince && Date.now() - stableSince >= 750) return state;
      if (lastText !== state.text || !stableSince) stableSince = Date.now();
      lastText = state.text;
    } else {
      stableSince = 0;
    }
    await page.waitForTimeout(500);
  }
  throw new ProviderError("response_timeout", `ChatGPT did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}

export class OpenAIWebProvider {
  constructor(options = {}) {
    this.id = "openai-web";
    this.displayName = "ChatGPT Web";
    this.capabilities = browserCapabilities({
      outputFormats: ["text", "markdown", "latex"],
      login: "persistent_local_profile",
    });
    this.settings = {
      profileDirectory: path.resolve(options.profileDirectory || process.env.WEB2API_OPENAI_PROFILE_DIR || path.join(os.homedir(), ".web2api", "profiles", "openai")),
      profileName: options.profileName || process.env.WEB2API_OPENAI_PROFILE_NAME || "Default",
      channel: options.channel || process.env.WEB2API_BROWSER_CHANNEL || "chrome",
      executablePath: options.executablePath || process.env.WEB2API_BROWSER_EXECUTABLE || null,
    };
    // ChatGPT currently rejects this profile in headless Chrome. Keep a small,
    // dedicated window minimized for generation; login remains visibly interactive.
    this.background = options.background ?? true;
  }

  async login({ timeoutMs = 15 * 60_000 } = {}) {
    const { context, page } = await launchBrowser(this.settings, { headed: true, displayName: this.displayName });
    try {
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
      await waitForReady(page, timeoutMs, { interactive: true });
      await ensureChatMode(page, Math.min(timeoutMs, 30_000));
      return { provider: this.id, status: "ready" };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async generate(request, { signal } = {}) {
    assertProviderSupportsRequest(this, request);
    signal?.throwIfAborted();
    const { context, page } = await launchBrowser(this.settings, {
      background: this.background,
      displayName: this.displayName,
    });
    const closeOnAbort = () => { void context.close().catch(() => {}); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
      await waitForReady(page, Math.min(request.timeoutMs, 60_000));
      await ensureChatMode(page, Math.min(request.timeoutMs, 30_000));
      const previousUsers = await page.locator(SELECTORS.user).count();
      const previousResponses = await page.locator(SELECTORS.assistant).count();
      const prompt = request.input.filter((item) => item.type === "text").map((item) => item.text).join("\n\n");
      const editor = page.locator(SELECTORS.prompt);
      await editor.fill(prompt);
      const actualPrompt = await editor.evaluate((node) => node instanceof HTMLTextAreaElement ? node.value : node.innerText);
      if (normalizeText(actualPrompt) !== normalizeText(prompt)) {
        throw new ProviderError("composer_mismatch", "ChatGPT's composer did not retain the submitted prompt.");
      }
      const sendReady = await page.waitForFunction((selector) => {
        const button = document.querySelector(selector);
        return button && !button.disabled && button.getClientRects().length > 0;
      }, SELECTORS.send, { timeout: Math.min(request.timeoutMs, 30_000), polling: 100 });
      await sendReady.dispose();
      if (!(await page.evaluate(chatModeSelected, SELECTORS))) {
        throw new ProviderError("chat_mode_changed", "ChatGPT left Chat mode before submission. No prompt was submitted.");
      }
      await page.locator(SELECTORS.send).click({ timeout: Math.min(request.timeoutMs, 30_000) });
      const submitted = await page.waitForFunction(({ selector, previousCount, expected }) => {
        const nodes = [...document.querySelectorAll(selector)];
        return nodes.length > previousCount && (nodes.at(-1).innerText || "").replace(/\s+/gu, " ").trim() === expected;
      }, { selector: SELECTORS.user, previousCount: previousUsers, expected: normalizeText(prompt) },
      { timeout: Math.min(request.timeoutMs, 30_000), polling: 250 }).catch((error) => {
        throw new ProviderError("submission_unconfirmed", "ChatGPT did not confirm the submitted prompt; web2api will not send a duplicate request.", { cause: error });
      });
      await submitted.dispose();
      const response = await waitForResponse(page, previousResponses, { timeoutMs: request.timeoutMs, signal, format: request.output.format });
      return {
        text: response.text,
        outputEnforcement: "dom_extraction",
        artifacts: [],
        providerMetadata: { conversationUrl: page.url(), mode: "chat", extraction: response.extraction },
      };
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => {});
    }
  }
}

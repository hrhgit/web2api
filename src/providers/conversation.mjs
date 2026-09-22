import { ProviderError } from "./provider.mjs";

export function conversationAddress(value, provider) {
  let url;
  try { url = new URL(value); } catch { /* rejected below */ }
  const valid = url && !url.username && !url.password && !url.port && url.protocol === "https:" &&
    (provider === "openai-web" ? url.hostname === "chatgpt.com" && /^\/c\/[a-zA-Z0-9-]+$/u.test(url.pathname)
      : url.hostname === "gemini.google.com" && /^\/app\/[a-zA-Z0-9_-]+$/u.test(url.pathname));
  if (!valid) throw new ProviderError("conversation_unavailable", "A resumable provider conversation address is unavailable.");
  return `${url.origin}${url.pathname}`;
}

export function assertConversationPage(page, address, provider) {
  if (conversationAddress(page.url(), provider) !== conversationAddress(address, provider)) {
    throw new ProviderError("conversation_unavailable", "The provider did not reopen the requested conversation. No follow-up was sent.");
  }
}

// Reopening a saved address is insufficient: wait for loaded, completed history.
export async function waitForConversationIdle(page, { address, provider, state, userSelector, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    assertConversationPage(page, address, provider);
    const current = await state();
    const users = await page.locator(userSelector).count();
    if (users > 0 && current.count >= users && current.text && !current.busy &&
        current.complete !== false && !current.error && !current.visibleError && !current.needsLogin && !current.challenge) {
      const signature = JSON.stringify([users, current.count, current.text]);
      if (signature !== previous) { previous = signature; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 2500) return;
    } else { previous = ""; stableSince = 0; }
    await page.waitForTimeout(250);
  }
  throw new ProviderError("conversation_busy", "The previous response is active or its completion could not be verified. No follow-up was sent.");
}

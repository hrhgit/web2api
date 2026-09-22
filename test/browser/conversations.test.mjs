import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "playwright-core";
import { GeminiWebProvider } from "../../src/providers/gemini-web.mjs";
import { OpenAIWebProvider } from "../../src/providers/openai-web.mjs";
import { Web2ApiGateway } from "../../src/core/gateway.mjs";
import { createApiServer, listenLocal } from "../../src/server.mjs";
import { Web2ApiClient } from "../../src/client.mjs";

let browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

for (const kind of ["gemini-web", "openai-web"]) {
  const openai = kind === "openai-web";
  const origin = openai ? "https://chatgpt.com" : "https://gemini.google.com";
  const route = openai ? "/c/test-conversation" : "/app/test-conversation";
  async function fixture(t, { busy = false, missing = false } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "web2api-native-turns-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const history = [];
    const navigations = [];
    const contexts = [];
    const ready = openai
      ? '<button data-testid="accounts-profile-button">Account</button><button role="radio" data-tpp-toggle-value="chatgpt" aria-checked="true">Chat</button><button role="radio" data-tpp-toggle-value="work" aria-checked="false">Work</button><div id="prompt-textarea" contenteditable="true"></div>'
      : '<a aria-label="Google Account: Fixture">Account</a><div role="textbox" contenteditable="true"></div>';
    const markup = (text, role) => role === "user"
      ? `<div data-message-author-role="user">${text}</div>`
      : openai ? `<article><div data-message-author-role="assistant"><div class="markdown">${text}</div></div><button data-testid="copy-turn-action-button">Copy</button></article>`
        : `<model-response><message-content>${text}</message-content></model-response>`;
    t.mock.method(chromium, "launchPersistentContext", async () => {
      const context = await browser.newContext(); contexts.push(context);
      await context.exposeBinding("saveTurn", (_source, text, wasBusy) => {
        assert.equal(wasBusy, false, "must not send while the previous response is active");
        history.push([text, `Answer ${history.length + 1}`]);
      });
      await context.route("**/*", async (intercept) => {
        const url = new URL(intercept.request().url()); navigations.push(url.pathname);
        const restored = url.pathname === route ? history.map(([q, a]) => markup(q, "user") + markup(a, "assistant")).join("") : "";
        await intercept.fulfill({ contentType: "text/html", body: `${ready}${restored}
          ${busy && restored ? '<button id="busy" data-testid="stop-button" aria-label="Stop generating">Stop</button>' : ""}
          <button data-testid="send-button" aria-label="Send" onclick="send()">Send</button>
          <script>
          if (${missing}) history.replaceState({}, '', ${JSON.stringify(openai ? "/" : "/app")});
          const markup = ${markup.toString()}; const openai = ${openai};
          async function send() {
            const text = document.querySelector('[contenteditable]').innerText;
            await saveTurn(text, !!document.querySelector('#busy'));
            document.body.insertAdjacentHTML('beforeend', markup(text, 'user') + markup('Answer ' + (document.querySelectorAll('[data-message-author-role="user"]').length + 1), 'assistant'));
            history.pushState({}, '', ${JSON.stringify(route)});
          }
          </script>` });
      });
      return context;
    });
    t.after(async () => { for (const c of contexts) await c.close(); });
    const provider = openai ? new OpenAIWebProvider({ profileDirectory: directory, background: false }) : new GeminiWebProvider({ profileDirectory: directory });
    return { provider, directory, history, navigations };
  }

  test(`${kind}: HTTP client appends two queued turns to the same native conversation`, async (t) => {
    const f = await fixture(t);
    const gateway = await new Web2ApiGateway({ dataDirectory: path.join(f.directory, "data"), providers: [f.provider] }).init();
    const server = createApiServer({ gateway });
    const address = await listenLocal(server, { port: 0 });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = new Web2ApiClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const first = await client.submit({ provider: kind, conversationId: "new", input: [{ type: "text", text: "Remember alpha" }] });
    const second = await client.submit({ provider: kind, conversationId: first.conversationId, input: [{ type: "text", text: "What did I ask?" }] });
    const third = await client.submit({ provider: kind, conversationId: first.conversationId, input: [{ type: "text", text: "Continue" }] });
    const result = await client.waitForTerminal(third.id, { timeoutMs: 30000, intervalMs: 25 });
    assert.equal(result.status, "completed", JSON.stringify(result.error));
    assert.equal(result.output.text, "Answer 3");
    assert.equal((await client.getJob(second.id)).output.text, "Answer 2");
    assert.deepEqual(f.history.map(([q]) => q), ["Remember alpha", "What did I ask?", "Continue"]);
    assert.deepEqual(f.navigations, [openai ? "/" : "/app", route, route]);
  });

  test(`${kind}: active upstream response is never interrupted`, async (t) => {
    const f = await fixture(t, { busy: true }); f.history.push(["earlier", "unfinished"]);
    await assert.rejects(() => f.provider.generate({ provider: kind, conversationId: "new", input: [{ type: "text", text: "follow-up" }], output: { format: "text" }, timeoutMs: 500 }, { conversationUrl: origin + route }), { code: "conversation_busy" });
    assert.equal(f.history.length, 1);
  });

  test(`${kind}: missing conversation fails without sending into a new chat`, async (t) => {
    const f = await fixture(t, { missing: true });
    await assert.rejects(() => f.provider.generate({ provider: kind, conversationId: "new", input: [{ type: "text", text: "follow-up" }], output: { format: "text" }, timeoutMs: 1000 }, { conversationUrl: origin + route }), { code: "conversation_unavailable" });
    assert.equal(f.history.length, 0);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";
import { OpenAIWebProvider } from "../../src/providers/openai-web.mjs";
import { minimizeBrowserWindow } from "../../src/providers/browser-session.mjs";
import { createWeb2ApiApp } from "../../src/app.mjs";
import { createApiServer, listenLocal } from "../../src/server.mjs";

let browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

const account = '<button data-testid="accounts-profile-button">Account</button>';
const editor = '<div id="prompt-textarea" contenteditable="true"></div>';
const login = '<a data-testid="login-button" href="https://auth.openai.com/log-in">Log in</a>';
const answer = String.raw`<div class="markdown"><h2>Answer</h2><p>Formula <span class="katex"><math><annotation encoding="application/x-tex">\frac{a}{b}</annotation></math><span class="katex-html" aria-hidden="true">duplicate fraction</span></span>.</p><p>Something went wrong is quoted prose.</p></div>`;

function modeControls(initial = "chatgpt", canSwitch = true) {
  return `<div role="radiogroup" aria-label="Select chat surface">${["chatgpt", "work"].map((mode) =>
    `<button role="radio" data-tpp-toggle-value="${mode}" aria-checked="${mode === initial}" onclick="${canSwitch ? "for (const radio of this.parentElement.querySelectorAll('[role=radio]')) radio.setAttribute('aria-checked', String(radio === this))" : ""}">${mode === "chatgpt" ? "Chat" : "Work"}</button>`,
  ).join("")}</div>`;
}

function request(format = "text", timeoutMs = 5000) {
  return { provider: "openai-web", input: [{ type: "text", text: "Explain this.\nKeep the request unchanged." }], output: { format }, timeoutMs };
}

async function fixtureProvider(t, renderPage) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "web2api-openai-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await browser.newContext();
  t.after(() => context.close());
  const prompts = [];
  const submittedModes = [];
  await context.exposeBinding("capturePrompt", (_source, text, mode) => { prompts.push(text); submittedModes.push(mode); });
  await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: renderPage(new URL(route.request().url())) }));
  const page = await context.newPage();
  t.mock.method(chromium, "launchPersistentContext", async () => context);
  return { provider: new OpenAIWebProvider({ profileDirectory: path.join(directory, "profile"), background: false }), directory, context, page, prompts, submittedModes };
}

test("a ChatGPT generation defaults to a minimized headed window", () => {
  assert.equal(new OpenAIWebProvider().background, true);
});

test("background browser windows are minimized and verified before a prompt is sent", async () => {
  const calls = [];
  const session = {
    async send(method, parameters) {
      calls.push({ method, parameters });
      if (method === "Browser.getWindowForTarget") return { windowId: 42 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "minimized" } };
      return {};
    },
    async detach() { calls.push({ method: "detach" }); },
  };
  await minimizeBrowserWindow({ newCDPSession: async () => session }, {}, { displayName: "ChatGPT Web" });
  assert.deepEqual(calls, [
    { method: "Browser.getWindowForTarget", parameters: undefined },
    { method: "Browser.setWindowBounds", parameters: { windowId: 42, bounds: { windowState: "minimized" } } },
    { method: "Browser.getWindowBounds", parameters: { windowId: 42 } },
    { method: "detach" },
  ]);
});

test("an unverifiable background window fails before a prompt can be sent", async () => {
  const session = {
    async send(method) {
      if (method === "Browser.getWindowForTarget") return { windowId: 42 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    },
    async detach() {},
  };
  await assert.rejects(
    minimizeBrowserWindow({ newCDPSession: async () => session }, {}, { displayName: "ChatGPT Web" }),
    (error) => error.code === "background_window_unavailable" && /No prompt was submitted/u.test(error.message),
  );
});

function responsePage({ html = answer, notification = "", confirm = true, respond = true, finishAfter = 0, before = "", mode = "chatgpt", canSwitch = true, changeModeOnInput = false } = {}) {
  return `<!doctype html><body>${account}${mode ? modeControls(mode, canSwitch) : ""}${editor}${before}
    <button data-testid="send-button" onclick="send()">Send</button>
    <script>
      function send() {
        const text = document.querySelector('#prompt-textarea').innerText;
        capturePrompt(text, document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('data-tpp-toggle-value'));
        if (${confirm}) {
          const user = document.createElement('div');
          user.dataset.messageAuthorRole = 'user';
          user.textContent = text;
          document.body.append(user);
        }
        if (${respond}) {
          const turn = document.createElement('article');
          turn.innerHTML = ${JSON.stringify(`<div data-message-author-role="assistant">${html}</div><button data-testid="copy-turn-action-button">Copy</button>`)};
          document.body.append(turn);
          if (${finishAfter}) {
            const stop = document.createElement('button');
            stop.dataset.testid = 'stop-button';
            stop.textContent = 'Stop';
            document.body.append(stop);
            setTimeout(() => {
              turn.querySelector('.markdown').innerHTML = '<p>Final answer.</p>';
              stop.remove();
            }, ${finishAfter});
          }
        }
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(notification)});
      }
      if (${changeModeOnInput}) document.querySelector('#prompt-textarea').addEventListener('input', () => {
        document.querySelector('[data-tpp-toggle-value="chatgpt"]').setAttribute('aria-checked', 'false');
        document.querySelector('[data-tpp-toggle-value="work"]').setAttribute('aria-checked', 'true');
      });
    </script>`;
}

test("login waits through auth and verification and closes only when the signed-in composer is ready", async (t) => {
  const fixture = await fixtureProvider(t, (url) => {
    if (url.hostname === "auth.openai.com") return '<a href="https://chatgpt.com/?verify=1">Continue</a>';
    if (url.searchParams.has("verify")) return '<title>Just a moment...</title><a href="https://chatgpt.com/?ready=1">Finish verification</a>';
    return url.searchParams.has("ready") ? account + modeControls("work") + editor : login + editor;
  });
  const pending = fixture.provider.login({ timeoutMs: 5000 });
  await fixture.page.getByRole("link", { name: "Log in", exact: true }).click();
  await fixture.page.getByRole("link", { name: "Continue", exact: true }).click();
  await fixture.page.getByRole("link", { name: "Finish verification", exact: true }).click();
  assert.deepEqual(await pending, { provider: "openai-web", status: "ready" });
  assert.equal(fixture.context.pages().length, 0);
});

test("a guest composer is not treated as a logged-in session", async (t) => {
  const fixture = await fixtureProvider(t, () => login + editor);
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "needs_login");
  assert.deepEqual(fixture.prompts, []);
  assert.equal(fixture.context.pages().length, 0);
});

test("Cloudflare verification fails explicitly without submitting or retrying", async (t) => {
  const fixture = await fixtureProvider(t, () => '<title>Just a moment...</title><div id="challenge-stage">Verify</div>');
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "browser_verification_required");
  assert.deepEqual(fixture.prompts, []);
  assert.equal(fixture.context.pages().length, 0);
});

for (const format of ["text", "markdown", "latex"]) {
  test(`${format} returns only the new answer, source formulas and unchanged caller prompt`, async (t) => {
    const fixture = await fixtureProvider(t, () => responsePage({
      before: '<article><div data-message-author-role="assistant"><div class="markdown">OLD ANSWER</div></div><button data-testid="copy-turn-action-button">Old copy</button></article>',
    }));
    const submitted = request(format);
    const result = await fixture.provider.generate(submitted);
    assert.deepEqual(fixture.prompts, [submitted.input[0].text]);
    assert.deepEqual(fixture.submittedModes, ["chatgpt"]);
    const heading = format === "markdown" ? "## Answer" : "Answer";
    const formula = format === "markdown" ? "$\\frac{a}{b}$" : format === "latex" ? "\\(\\frac{a}{b}\\)" : "\\frac{a}{b}";
    assert.equal(result.text, `${heading}\n\nFormula ${formula}.\n\nSomething went wrong is quoted prose.`);
    assert.equal(result.outputEnforcement, "dom_extraction");
    assert.equal(result.providerMetadata.mode, "chat");
    assert.deepEqual(result.providerMetadata.extraction, { source: "response_dom", math: { source: 1, rendered: 0 } });
    assert.deepEqual(result.artifacts, []);
    assert.equal(fixture.context.pages().length, 0);
  });
}

test("a default Work surface switches to Chat before entering the caller's prompt", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ mode: "work" }));
  const result = await fixture.provider.generate(request());
  assert.equal(result.providerMetadata.mode, "chat");
  assert.deepEqual(fixture.submittedModes, ["chatgpt"]);
});

for (const mode of ["work", null]) {
  test(`an unconfirmed Chat mode (${mode || "missing controls"}) fails without sending`, async (t) => {
    const fixture = await fixtureProvider(t, () => responsePage({ mode, canSwitch: false }));
    await assert.rejects(fixture.provider.generate(request("text", 1000)), (error) => error.code === "chat_mode_unavailable");
    assert.deepEqual(fixture.prompts, []);
  });
}

test("a mode change during prompt entry is detected before submission", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ changeModeOnInput: true }));
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "chat_mode_changed");
  assert.deepEqual(fixture.prompts, []);
});

test("Chat mode is rechecked after waiting for the send button to become enabled", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage()
    .replace('<button data-testid="send-button"', '<button disabled data-testid="send-button"')
    .replace('</script>', `document.querySelector('#prompt-textarea').addEventListener('input', () => setTimeout(() => {
      document.querySelector('[data-tpp-toggle-value="chatgpt"]').setAttribute('aria-checked', 'false');
      document.querySelector('[data-tpp-toggle-value="work"]').setAttribute('aria-checked', 'true');
      document.querySelector('[data-testid="send-button"]').disabled = false;
    }, 150));</script>`));
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "chat_mode_changed");
  assert.deepEqual(fixture.prompts, []);
});

test("stable partial text is not completed while the stop button remains", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ html: '<div class="markdown">Partial answer.</div>', finishAfter: 1800 }));
  const result = await fixture.provider.generate(request());
  assert.equal(result.text, "Final answer.");
});

test("multiple Markdown bodies retain their order", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ html: '<div class="markdown"><p>First</p></div><div class="markdown"><pre><code>second</code></pre></div>' }));
  const result = await fixture.provider.generate(request("markdown"));
  assert.equal(result.text, "First\n\n```\nsecond\n```");
});

test("visible usage-limit notifications fail the job", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ respond: false, notification: '<div role="alert">You have reached your usage limit.</div>' }));
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "rate_limited");
  assert.equal(fixture.prompts.length, 1);
});

test("an unconfirmed submission is never automatically resent", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ confirm: false, respond: false }));
  await assert.rejects(fixture.provider.generate(request("text", 1000)), (error) => error.code === "submission_unconfirmed");
  assert.equal(fixture.prompts.length, 1);
});

test("an old completed answer cannot satisfy a new request", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({
    respond: false,
    before: '<article><div data-message-author-role="assistant"><div class="markdown">OLD ANSWER</div></div><button data-testid="copy-turn-action-button">Copy</button></article>',
  }));
  await assert.rejects(fixture.provider.generate(request("text", 1200)), (error) => error.code === "response_timeout");
});

test("aborting a request releases the provider browser", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage({ respond: false }));
  const controller = new AbortController();
  const rejected = assert.rejects(fixture.provider.generate(request(), { signal: controller.signal }));
  await fixture.page.locator('[data-message-author-role="user"]').waitFor();
  controller.abort(new Error("Test cancellation"));
  await rejected;
  assert.equal(fixture.context.pages().length, 0);
});

test("profile lock errors never expose the local profile path", async (t) => {
  const fixture = await fixtureProvider(t, () => "");
  t.mock.method(chromium, "launchPersistentContext", async () => { throw new Error(`ProcessSingleton: ${fixture.directory}`); });
  await assert.rejects(fixture.provider.generate(request()), (error) => error.code === "profile_busy" && !error.message.includes(fixture.directory));
});

test("the HTTP job contract exposes OpenAI extraction and hides its profile settings", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage());
  const { gateway } = await createWeb2ApiApp({ dataDirectory: path.join(fixture.directory, "jobs"), providers: [fixture.provider] });
  const server = createApiServer({ gateway });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = await listenLocal(server, { port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${origin}/v1/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("markdown", 30000)) });
  assert.equal(created.status, 202);
  const job = await created.json();
  await gateway.waitForTerminal(job.id, { timeoutMs: 5000 });
  const result = await (await fetch(`${origin}/v1/jobs/${job.id}`)).json();
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "openai-web");
  assert.equal(result.output.format, "markdown");
  assert.equal(result.output.enforcement, "dom_extraction");
  assert.equal(JSON.stringify(result).includes(fixture.directory), false);
});

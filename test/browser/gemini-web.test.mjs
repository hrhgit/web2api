import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";
import { GeminiWebProvider } from "../../src/providers/gemini-web.mjs";

let browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

const account = '<a aria-label="Google Account: Fixture" href="#">Fixture account</a>';
const editor = '<div role="textbox" contenteditable="true"></div>';
const signIn = '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>';

async function fixtureProvider(t, renderPage) {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "web2api-browser-test-"));
  t.after(() => rm(profileDirectory, { recursive: true, force: true }));
  const context = await browser.newContext();
  t.after(() => context.close());
  let submittedPrompt = null;
  await context.exposeBinding("capturePrompt", (_source, text) => { submittedPrompt = text; });
  // Every navigation is served locally, including the simulated sign-in redirects.
  await context.route("**/*", (route) => route.fulfill({
    contentType: "text/html", body: renderPage(new URL(route.request().url())),
  }));
  const page = await context.newPage();
  t.mock.method(chromium, "launchPersistentContext", async () => context);
  return {
    provider: new GeminiWebProvider({ profileDirectory }), context, page,
    get submittedPrompt() { return submittedPrompt; },
  };
}

function responsePage(responseHtml, notificationHtml = "") {
  return `<!doctype html><body>${account}${editor}
    <button aria-label="Send" onclick="send()">Send</button>
    <script>
      function send() {
        const text = document.querySelector('[role="textbox"]').innerText;
        capturePrompt(text);
        const query = document.createElement('user-query');
        query.textContent = text;
        document.body.append(query);
        const response = document.createElement('model-response');
        response.innerHTML = ${JSON.stringify(`<message-content>${responseHtml}</message-content>`)};
        document.body.append(response);
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(notificationHtml)});
      }
    </script>`;
}

test("interactive login waits through signed-out and redirect pages until Gemini is ready", async (t) => {
  const { provider, context, page } = await fixtureProvider(t, (url) => {
    if (url.hostname === "accounts.google.com") {
      return '<!doctype html><body><a href="https://gemini.google.com/app?authenticated=1">Finish sign in</a>';
    }
    return `<!doctype html><body>${url.searchParams.has("authenticated") ? account + editor : signIn}`;
  });
  const login = provider.login({ timeoutMs: 5000 }).then((result) => ({ result }), (error) => ({ error }));
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Finish sign in", exact: true }).click();
  const outcome = await login;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result.provider, "gemini-web");
  assert.equal(context.pages().length, 0);
});

test("generation still reports needs_login without waiting for interactive login", async (t) => {
  const { provider, context } = await fixtureProvider(t, () => `<!doctype html><body>${signIn}${editor}`);
  await assert.rejects(provider.generate({ input: [{ type: "text", text: "hello" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => error.code === "needs_login");
  assert.equal(context.pages().length, 0);
});

test("prompt and response error phrases are ordinary content, with no format instructions appended", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage(
    '<p>Something went wrong is an example phrase.</p><div role="alert">An error occurred</div>',
    '<div role="alert" hidden>You have reached your limit</div>',
  ));
  const task = "Translate Something went wrong; explain Markdown and LaTeX.";
  const result = await fixture.provider.generate({ input: [{ type: "text", text: task }], output: { format: "text" }, timeoutMs: 10000 });
  assert.equal(fixture.submittedPrompt, task);
  assert.match(result.text, /Something went wrong is an example phrase/);
  assert.equal(result.outputEnforcement, "dom_extraction");
});

for (const format of ["markdown", "latex"]) {
  test(`${format} extraction preserves the prompt and returns text with formula provenance`, async (t) => {
    const fixture = await fixtureProvider(t, () => responsePage(
      '<h2>Answer</h2><p>Area <span class="math-inline" data-math="A=\\pi r^2"><span>rendered formula</span></span>.</p>',
    ));
    const prompt = "Explain the area.\nKeep this exact request.";
    const result = await fixture.provider.generate({ input: [{ type: "text", text: prompt }], output: { format }, timeoutMs: 10000 });
    assert.equal(fixture.submittedPrompt, prompt);
    assert.equal(result.text, format === "markdown" ? "## Answer\n\nArea $A=\\pi r^2$." : "Answer\n\nArea \\(A=\\pi r^2\\).");
    assert.equal(result.outputEnforcement, "dom_extraction");
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.providerMetadata.extraction, { source: "response_dom", math: { source: 1, rendered: 0 } });
  });
}

test("a source-only formula completes even without rendered DOM text", async (t) => {
  const { provider } = await fixtureProvider(t, () => responsePage('<span class="math-inline" data-math="x^2"></span>'));
  const result = await provider.generate({ input: [{ type: "text", text: "square x" }], output: { format: "latex" }, timeoutMs: 10000 });
  assert.equal(result.text, "\\(x^2\\)");
});

test("a visible UI error notification still fails generation", async (t) => {
  const { provider } = await fixtureProvider(t, () => responsePage("", '<div role="alert">Something went wrong</div>'));
  await assert.rejects(provider.generate({ input: [{ type: "text", text: "hello" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => error.code === "provider_ui_error");
});

test("browser profile lock errors do not disclose the local profile path", async (t) => {
  const { provider } = await fixtureProvider(t, () => "");
  t.mock.method(chromium, "launchPersistentContext", async () => {
    throw new Error(`ProcessSingleton: ${provider.settings.profileDirectory}`);
  });
  await assert.rejects(provider.generate({ input: [{ type: "text", text: "hello" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => error.code === "profile_busy" && !error.message.includes(provider.settings.profileDirectory));
});

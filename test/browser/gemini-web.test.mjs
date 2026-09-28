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

function modelControls(initial = "gemini-flash", { compactSummary = false, legacyTestId = true } = {}) {
  const options = [
    ["gemini-flash", "Gemini Flash"],
    ["gemini-pro", "Gemini Pro"],
  ];
  const [initialId, initialLabel] = options.find(([id]) => id === initial) || options[0];
  const pickerLabel = compactSummary ? `Open mode picker, currently ${initialLabel.replace(/^Gemini /u, "")}` : initialLabel;
  const pickerAttributes = compactSummary ? "" : ` data-model-id="${initialId}" data-model-label="${initialLabel}"`;
  const pickerText = compactSummary ? initialLabel.replace(/^Gemini /u, "") : initialLabel;
  const testId = legacyTestId ? ' data-testid="bard-mode-menu-button"' : "";
  return `<button${testId} aria-haspopup="menu"${pickerAttributes} aria-label="${pickerLabel}" onclick="toggleModelMenu()">${pickerText}</button>
    <div id="model-menu" role="menu" hidden>${options.map(([id, label]) =>
      `<button role="menuitemradio" data-model-id="${id}" data-model-label="${label}" aria-checked="${id === initialId}" onclick="chooseModel(this)">${label}</button>`,
    ).join("")}</div>
    <script>
      function toggleModelMenu() { document.querySelector('#model-menu').hidden = !document.querySelector('#model-menu').hidden; }
      function chooseModel(option) {
        for (const entry of document.querySelectorAll('#model-menu [role=menuitemradio]')) entry.setAttribute('aria-checked', String(entry === option));
        const picker = document.querySelector('[data-testid=bard-mode-menu-button]') || document.querySelector('button[aria-label^="Open mode picker"]');
        picker.dataset.modelId = option.dataset.modelId;
        picker.dataset.modelLabel = option.dataset.modelLabel;
        picker.setAttribute('aria-label', option.dataset.modelLabel);
        picker.textContent = option.dataset.modelLabel;
        document.querySelector('#model-menu').hidden = true;
      }
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelector('#model-menu').hidden = true; });
    </script>`;
}

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

function responsePage(responseHtml, notificationHtml = "", { initialModel = "gemini-flash", changeModelOnInput = false, compactModelSummary = false, legacyTestId = true } = {}) {
  return `<!doctype html><body>${account}${modelControls(initialModel, { compactSummary: compactModelSummary, legacyTestId })}${editor}
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
      if (${changeModelOnInput}) document.querySelector('[role="textbox"]').addEventListener('input', () => {
        chooseModel(document.querySelector('[data-model-id="gemini-flash"]'));
      });
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

test("readiness checks the composer without submitting a model prompt", async (t) => {
  const fixture = await fixtureProvider(t, () => `<!doctype html><body>${account}${editor}`);
  await fixture.provider.check({ timeoutMs: 3000 });
  assert.equal(fixture.submittedPrompt, null);
  assert.equal(fixture.context.pages().length, 0);
});

test("Gemini discovers account-visible model choices without submitting a prompt", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage(""));
  const models = await fixture.provider.listModels({ timeoutMs: 3000 });
  assert.deepEqual(models, [
    { id: "gemini-flash", label: "Gemini Flash", selected: true, available: true },
    { id: "gemini-pro", label: "Gemini Pro", selected: false, available: true },
  ]);
  assert.equal(fixture.submittedPrompt, null);
  assert.equal(fixture.context.pages().length, 0);
});

test("Gemini recognizes a compact current-model announcement", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("", "", { initialModel: "gemini-pro", compactModelSummary: true }));
  const models = await fixture.provider.listModels({ timeoutMs: 3000 });
  assert.deepEqual(models, [
    { id: "gemini-flash", label: "Gemini Flash", selected: false, available: true },
    { id: "gemini-pro", label: "Gemini Pro", selected: true, available: true },
  ]);
  assert.equal(fixture.submittedPrompt, null);
});

test("Gemini discovers the current Open mode picker without a legacy test id", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("", "", { compactModelSummary: true, legacyTestId: false }));
  const models = await fixture.provider.listModels({ timeoutMs: 3000 });
  assert.deepEqual(models, [
    { id: "gemini-flash", label: "Gemini Flash", selected: true, available: true },
    { id: "gemini-pro", label: "Gemini Pro", selected: false, available: true },
  ]);
  assert.equal(fixture.submittedPrompt, null);
});

test("Gemini selects a discovered model and records UI confirmation", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("Selected result"));
  const prompt = "Use the selected model.";
  const result = await fixture.provider.generate({
    model: "gemini-pro", input: [{ type: "text", text: prompt }], output: { format: "text" }, timeoutMs: 10_000,
  });
  assert.equal(fixture.submittedPrompt, prompt);
  assert.deepEqual(result.providerMetadata.modelSelection, {
    requested: "gemini-pro",
    selected: { id: "gemini-pro", label: "Gemini Pro" },
    source: "ui_selection",
  });
});

test("Gemini rejects an unavailable model before submitting a prompt", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("Should not submit"));
  await assert.rejects(
    fixture.provider.generate({ model: "not-in-catalog", input: [{ type: "text", text: "never send" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => error.code === "model_unavailable",
  );
  assert.equal(fixture.submittedPrompt, null);
});

test("Gemini annotates a failed provider operation with its safe execution phase", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("Should not submit"));
  await assert.rejects(
    fixture.provider.generate({ model: "not-in-catalog", input: [{ type: "text", text: "never send" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => {
      assert.equal(error.code, "model_unavailable");
      assert.equal(error.details?.diagnostic?.phase, "model_selection");
      assert.equal(error.details?.diagnostic?.underlying?.name, "ProviderError");
      assert.equal(error.details?.diagnostic?.underlying?.code, "model_unavailable");
      return true;
    },
  );
  assert.equal(fixture.submittedPrompt, null);
});

test("Gemini refuses submission when its selected model changes during prompt entry", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("Should not submit", "", { changeModelOnInput: true }));
  await assert.rejects(
    fixture.provider.generate({ model: "gemini-pro", input: [{ type: "text", text: "never send" }], output: { format: "text" }, timeoutMs: 3000 }),
    (error) => error.code === "model_selection_changed",
  );
  assert.equal(fixture.submittedPrompt, null);
});

test("cancelling one Gemini job leaves the concurrent job's page and response intact", async (t) => {
  const fixture = await fixtureProvider(t, () => responsePage("Independent result"));
  const controller = new AbortController();
  const request = { input: [{ type: "text", text: "first" }], output: { format: "text" }, timeoutMs: 10000 };
  const first = fixture.provider.generate(request, { signal: controller.signal }).then(() => "completed", () => "cancelled");
  const second = fixture.provider.generate({ ...request, input: [{ type: "text", text: "second" }] });
  await fixture.page.locator("user-query").waitFor();
  controller.abort(new Error("cancel first"));
  assert.equal(await first, "cancelled");
  assert.equal((await second).text, "Independent result");
  assert.equal(fixture.context.pages().length, 0);
});

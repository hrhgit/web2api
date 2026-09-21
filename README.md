# web2api

`web2api` is a local, capability-declared gateway for AI **web applications** driven through a browser. It is deliberately not a replacement for an official model API.

This is a same-machine service, not a public or remotely deployable model API. It is designed to listen on loopback and use browser profiles and files owned by the same machine. Do not expose it to the public internet or put it behind a public reverse proxy.

The project separates a job/artifact contract from provider-specific browser automation. A caller can submit text and supported local attachments, inspect a job, and retrieve safely staged provider artifacts. Output formats are checked against the selected provider's capabilities.

## What v0.1 includes

- Local-only HTTP job API (`127.0.0.1` by default)
- Persistent jobs, concurrent-safe idempotency within one service process, explicit `needs_login` state, and per-provider FIFO execution
- First-class artifacts with media type, SHA-256, byte size, source provenance, and a contained local copy
- Text, Markdown structure, and LaTeX formula-source extraction from provider response DOMs
- A deterministic `mock-web` provider for integration tests and client development
- A Gemini Web adapter for text/local-file turns through a dedicated Playwright Chrome profile
- A ChatGPT Web adapter (`openai-web`) for text turns through its own persistent Chrome profile

Neither web adapter collects generated downloads or images yet. The common artifact contract is in place so that capability can be added without changing callers. ChatGPT currently accepts text input only; local attachments are rejected explicitly. Claude Web is not registered yet.

| Provider | Text input | Local attachments | Text / Markdown / LaTeX extraction | Downloads / images |
| --- | --- | --- | --- | --- |
| `gemini-web` | Yes | Yes | Yes | No |
| `openai-web` (ChatGPT) | Yes | No | Yes | No |
| `mock-web` | Yes | No | Synthetic test output | No |

## Deliberate capability boundary

Web UIs are session-driven products, not automatically equivalent to provider APIs. In particular, `web2api` v0.1 rejects `system`/`instructions` and `tools` rather than pretending they have native model semantics. It also does not claim token usage, temperature control, native JSON-schema mode, or token streaming. Optional `model` requests are accepted only when the selected adapter declares `modelSelection: true` and implements that selection; no bundled provider currently does. The website's selected model and account settings still apply.

Both web adapters submit the caller's text without adding formatting instructions. Their `text`, `markdown`, and `latex` formats select how the response DOM is extracted; all return a string in `output.text`, with `output.enforcement: "dom_extraction"`. The mock provider returns synthetic text for client tests and does not demonstrate real-site extraction.

Unknown fields are rejected at the request, input-item, and output levels. They are never silently dropped or forwarded as provider-specific options.

## Install and run

From a checkout:

```bash
npm install
npm start -- serve
```

From npm:

```bash
npm install @ruihuahe/web2api
npx web2api serve
```

The server listens on `http://127.0.0.1:8787` by default. It intentionally does not bind a public interface. Set `WEB2API_TOKEN` to require a bearer token from other local processes.

The package exposes a small HTTP client at `@ruihuahe/web2api/client`:

```js
import { Web2ApiClient } from "@ruihuahe/web2api/client";

const client = new Web2ApiClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.WEB2API_TOKEN,
});
const submitted = await client.submit({
  provider: "mock-web",
  input: [{ type: "text", text: "Explain Bayes rule." }],
});
const completed = await client.waitForTerminal(submitted.id);
console.log(completed.output.text);
```

Run one service process per data directory. Admission and idempotency are serialized within that process; generation is queued separately per provider. Multi-process scheduling is not implemented.

```bash
curl http://127.0.0.1:8787/v1/providers

curl -X POST http://127.0.0.1:8787/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "provider": "mock-web",
    "input": [{"type":"text","text":"Explain Bayes rule."}],
    "output": {"format":"markdown"},
    "idempotencyKey": "demo-bayes-001"
  }'
```

Poll `GET /v1/jobs/<job-id>`. A completed job contains `output.text` and any staged `artifacts`; an artifact can be downloaded from its `downloadUrl`.

## Job outcomes and retries

- Concurrent submissions with the same provider, idempotency key, and normalized request return one job. Reusing the key for a different request returns HTTP `409` (`idempotency_conflict`).
- On service startup, leftover `queued` and `running` jobs become `failed` with error code `interrupted`. Saved outputs are retained, and requests are not automatically resent. The `providers` and `login` commands do not run job recovery.
- Idempotency keys remain associated with terminal jobs, including failures and `needs_login`. A deliberate new attempt uses a new key or omits it.
- If some artifacts cannot be staged, the job becomes `failed` with `artifact_collection_failed`. Generated text and successful artifacts remain accessible; `error.details.failures` lists each failed candidate's zero-based index and error code. All candidates are attempted unless the job times out.

## Browser login

Gemini uses `~/.web2api/profiles/gemini`; ChatGPT uses `~/.web2api/profiles/openai`. Both are separate from TransNote and the user's normal Chrome profile. ChatGPT uses browser sign-in, not an OpenAI API key; its authenticated session stays in that browser profile. See [OpenAI's web authentication documentation](https://learn.chatgpt.com/docs/auth#chatgpt-web).

```bash
npm start -- login gemini-web
npm start -- login openai-web
npm start -- serve
```

The login command opens a visible dedicated Chrome window and closes it after the signed-in composer is ready. Only one process may own a provider profile at a time. A request whose login has expired resolves as `needs_login`, retaining its job rather than pretending it was sent.

ChatGPT's profile can be configured with `WEB2API_OPENAI_PROFILE_DIR` and `WEB2API_OPENAI_PROFILE_NAME`. Browser selection is shared through `WEB2API_BROWSER_CHANNEL` (default `chrome`) or `WEB2API_BROWSER_EXECUTABLE`.

ChatGPT requests use a dedicated **headed Chrome window minimized immediately after launch**, rather than headless Chrome. The login command remains visibly interactive. At OS launch the window may briefly appear; if minimization cannot be verified, the job fails with `background_window_unavailable` before sending any prompt. This is the current OpenAI-specific default because the same logged-in profile was repeatedly blocked in headless Chrome.

ChatGPT requests open a new chat, explicitly select **Chat** rather than the website's possibly remembered Work surface, and check the selected radio state again immediately before sending. Missing or ineffective controls fail with `chat_mode_unavailable`; a mode change during prompt entry fails with `chat_mode_changed`. Neither failure submits the prompt. Successful results include `providerMetadata.mode: "chat"`.

After sending, the adapter confirms the user message and waits for the new assistant turn's completion controls and stable text. Generation errors, unconfirmed submissions, and rate limits are not retried automatically. A Cloudflare challenge returns `browser_verification_required`; the service does not solve it or treat the challenge page as an answer. Cloudflare [does not support automated browsers for production challenges](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/), so completing login in a visible window does not guarantee that later headless requests will work.

Live validation on 2026-09-21: manual login succeeded in normal Chrome using the dedicated profile, and a normal-browser test conversation verified the Chat/Work selector, prompt controls, response nodes, formula source, and completion controls. Repeated headless runs were blocked by Cloudflare before submission, while three minimized headed-background requests completed. Real Gemini and ChatGPT requests also verified Markdown headings, lists, inline code, and fenced code extraction; both providers exposed two LaTeX formula sources without fallback-to-rendered text. Gemini produced a displayed equation (`\\[...\\]`); ChatGPT rendered its separate equation inline, so source-faithful extraction returned `\\(...\\)` rather than inventing display delimiters. A real-account headless end-to-end generation is therefore **not working in this environment**. Local browser fixtures cover the adapter's API, extraction, mode selection, background-window failure, errors, and cancellation behavior.

## API shape

```json
{
  "provider": "gemini-web",
  "input": [
    {"type": "text", "text": "Summarize the attached paper."},
    {"type": "local_file", "path": "/absolute/path/to/paper.pdf"}
  ],
  "output": {
    "format": "text"
  },
  "artifactPolicy": "collect",
  "idempotencyKey": "paper-2026-001",
  "timeoutMs": 900000
}
```

`local_file` paths are intentionally a same-machine process feature. The path is not uploaded by the client: the web2api service opens it directly. It must be an absolute path that exists on the service host, so a client and service on different machines cannot share a local file by sending its path. Do not expose this server on a network or treat a browser profile as a shared API credential.

A ChatGPT text request uses the same endpoint and job contract:

```json
{
  "provider": "openai-web",
  "input": [{"type": "text", "text": "Explain Bayes rule with an example."}],
  "output": {"format": "markdown"},
  "artifactPolicy": "none",
  "timeoutMs": 900000
}
```

## Text extraction formats

Set `output.format` to choose the representation; it does not change the prompt sent to the provider.

| Format | Text returned in `output.text` |
| --- | --- |
| `text` (default) | Readable plain text, with provider-exposed formula source preserved as text without added math delimiters. |
| `markdown` | Headings, emphasis, links, nested lists, quotes, fenced code, and simple tables, with inline `$...$` and display `$$...$$` formulas. |
| `latex` | Plain prose and code, with inline `\(...\)` and display `\[...\]` formula source. It is not a compilable LaTeX document; prose is not converted or TeX-escaped. |

For example, the same request can select `"output": {"format": "markdown"}` or `"output": {"format": "latex"}`. A page displaying **Area** followed by a formula whose source is `A=\pi r^2` yields:

```text
markdown: **Area** $A=\pi r^2$
latex:    Area \(A=\pi r^2\)
text:     Area A=\pi r^2
```

Markdown is serialized from the page's structure, not recovered byte-for-byte from the model's original Markdown. Formula source is read from `data-math`, `data-math-source`, or TeX annotations in MathML, without rewriting its commands. Code content and its internal whitespace are retained; copy controls, hidden duplicate math renderings, and page UI are excluded. Text extraction does not download images or create files; image alternative text, when present, remains textual content.

When a recognized formula has no exposed source, extraction retains its visible text without guessing LaTeX. `providerMetadata.extraction` reports `source: "response_dom"` and `math: {"source": N, "rendered": M}`: the counts of formulas read from source and formulas retained as rendered text. These modes preserve available text and common structure; they do not reproduce arbitrary visual layouts.

## Adding a provider

A provider implements `id`, `capabilities`, `generate(request, context)`, and optionally `login()`. It returns `text`, an explicit `outputEnforcement`, and optionally an `artifacts` array. It must honor `context.signal`, release its browser on abort, and finish saving downloads before returning. Use `context.jobDirectory` for those files; paths to browser-owned temporary downloads may disappear when the browser closes. The gateway stages candidates inside its own data directory before publishing metadata or a download URL.

Provider error messages/details and result metadata are public API data. Keep local profile paths and credentials out of them; internal exception causes are not returned. Declare only capabilities the adapter actually implements.

The intended provider path is:

```text
TransNote or another client
        -> web2api job contract
        -> provider capability check and FIFO queue
        -> Gemini Web / OpenAI Web / Claude Web adapter
        -> staged text and artifacts
```

Before adding a web provider, validate its current UI, account/login behavior, user authorization, and applicable provider terms. Do not infer official-API semantics from a successful browser interaction.

## Development

```bash
npm test
npm run check
npm run test:browser
```

Browser regression tests require installed Google Chrome. They use isolated contexts and locally fulfilled pages to verify login redirects, unchanged prompt submission, error detection, Markdown structure, code whitespace, formula-source extraction, and ChatGPT job completion/cancellation without contacting AI services or using a signed-in profile. They do not verify current live provider selectors or real-account behavior.

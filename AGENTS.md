# AGENTS.md

## Harness

- Keep web2api a capability-declared adapter gateway: never claim full model-API compatibility for browser functionality that is unavailable or only emulated, including true system roles, native tool calls, model controls, token accounting, and token streaming.
- Keep each browser provider isolated behind its own adapter and persistent local profile. The service must default to loopback-only access and must never expose browser profile paths, cookies, or credentials through its API.
- Model generated files and images as first-class artifacts with origin metadata, media type, byte size, SHA-256, and a safely staged local copy; provider-specific UI extraction belongs in adapters, not response-text parsing.
- Match the public result to the requested modality: text requests return source-faithful textual information, including explicitly requested Markdown structure and provider-exposed LaTeX formula source; image and other-file requests return their safely staged artifacts. Text extraction must preserve caller prompts, declare supported representations and their provenance, and never synthesize a full LaTeX document or invent unavailable formula source.
- Add providers incrementally behind a tested capability matrix. Unsupported request features must fail explicitly instead of being silently dropped or converted into an untrusted prompt prefix.
- Before every ChatGPT request, explicitly verify Chat mode and switch away from Work when needed. Confirm the mode again before submitting; if Chat mode cannot be established, fail without sending the caller's input.
- Publish the npm package as the scoped `@ruihuahe/web2api` package with an explicit public publish configuration, a runtime `files` allowlist, a `LICENSE`, and a `./client` export; verify the published contents with `npm pack --dry-run`.
- Treat web2api as a same-machine loopback service rather than a public model API; `local_file` inputs must be absolute paths on the service host and must never imply file upload or cross-host access.

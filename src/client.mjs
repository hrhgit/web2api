const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_login", "cancelled"]);

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("baseUrl must be a non-empty URL string.");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return encodeURIComponent(value);
}

function parseFileName(contentDisposition) {
  if (typeof contentDisposition !== "string") return null;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(contentDisposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const quoted = /filename="([^"]*)"/iu.exec(contentDisposition);
  return quoted?.[1] || null;
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("The request was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || new Error("The request was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Web2ApiClientError extends Error {
  constructor(message, { code = "client_error", status = null, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "Web2ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class Web2ApiClient {
  #baseUrl;
  #fetch;
  #token;

  constructor({ baseUrl = DEFAULT_BASE_URL, token = null, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function or global fetch must be available.");
    }
    if (token !== null && (typeof token !== "string" || !token.trim())) {
      throw new TypeError("token must be null or a non-empty string.");
    }
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#fetch = fetchImpl;
    this.#token = token;
  }

  async #request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { signal: AbortSignal.timeout(90_000), ...init, headers });
    } catch (error) {
      throw new Web2ApiClientError("Could not reach the web2api service.", {
        code: "network_error",
        cause: error,
      });
    }

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Preserve the HTTP status even when the server returned a non-JSON error.
      }
      const error = body?.error || {};
      throw new Web2ApiClientError(
        typeof error.message === "string" && error.message
          ? error.message
          : `web2api request failed with HTTP ${response.status}.`,
        {
          code: typeof error.code === "string" && error.code ? error.code : "http_error",
          status: response.status,
          details: error.details ?? null,
        },
      );
    }
    return response;
  }

  async #json(path, init) {
    const response = await this.#request(path, init);
    try {
      return await response.json();
    } catch (error) {
      throw new Web2ApiClientError("web2api returned an invalid JSON response.", {
        code: "invalid_response",
        status: response.status,
        cause: error,
      });
    }
  }

  async health() {
    return this.#json("/health");
  }

  async listProviders() {
    const body = await this.#json("/v1/providers");
    if (!Array.isArray(body?.data)) {
      throw new Web2ApiClientError("web2api returned an invalid provider list.", { code: "invalid_response" });
    }
    return body.data;
  }

  async submit(payload) {
    return this.#json("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async getJob(jobId) {
    return this.#json(`/v1/jobs/${requireIdentifier(jobId, "jobId")}`);
  }

  async checkProvider(providerId) {
    return this.#json(`/v1/providers/${requireIdentifier(providerId, "providerId")}/check`, { method: "POST" });
  }

  async cancel(jobId) {
    return this.#json(`/v1/jobs/${requireIdentifier(jobId, "jobId")}/cancel`, { method: "POST" });
  }

  async waitForTerminal(jobId, { timeoutMs = 5 * 60_000, intervalMs = 250, signal } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative integer.");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new TypeError("intervalMs must be a positive integer.");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const job = await this.getJob(jobId);
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Web2ApiClientError(`Job ${jobId} did not reach a terminal state before the client timeout.`, {
          code: "client_timeout",
          status: 408,
        });
      }
      await sleep(Math.min(intervalMs, remaining), signal);
    }
  }

  async downloadArtifact(jobId, artifactId) {
    const response = await this.#request(
      `/v1/jobs/${requireIdentifier(jobId, "jobId")}/artifacts/${requireIdentifier(artifactId, "artifactId")}`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      fileName: parseFileName(response.headers.get("content-disposition")),
      mediaType: response.headers.get("content-type") || "application/octet-stream",
    };
  }
}

export default Web2ApiClient;

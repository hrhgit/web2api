import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  API_VERSION,
  ApiError,
  assertProviderSupportsRequest,
  normalizeGenerationRequest,
  TERMINAL_JOB_STATUSES,
} from "./contracts.mjs";
import { stageArtifactFromFile } from "./artifacts.mjs";
import { FileJobStore } from "./job-store.mjs";
import { ProviderError } from "../providers/provider.mjs";

class SerialTaskQueue {
  #waiting = [];
  #active = 0;
  constructor(limit = 1) { this.limit = limit; }
  get size() { return this.#waiting.length + this.#active; }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.#waiting.push({ task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.limit && this.#waiting.length) {
      const { task, resolve, reject } = this.#waiting.shift();
      this.#active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        this.#active--;
        this.#drain();
      });
    }
  }
}

function inputSummary(input) {
  return input.map((item) => item.type === "text"
    ? { type: "text", characters: item.text.length }
    : { type: "local_file", fileName: path.basename(item.path) });
}

function publicArtifact(jobId, artifact) {
  const { storedPath: _storedPath, ...publicFields } = artifact;
  return { ...publicFields, downloadUrl: `/v1/jobs/${jobId}/artifacts/${artifact.id}` };
}

function publicJob(job) {
  const { request, artifacts = [], ...rest } = job;
  return {
    ...rest,
    request: {
      provider: request.provider,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...("model" in request ? { model: request.model } : {}),
      input: inputSummary(request.input),
      output: request.output,
      artifactPolicy: request.artifactPolicy,
      idempotencyKey: request.idempotencyKey,
      timeoutMs: request.timeoutMs,
    },
    artifacts: artifacts.map((artifact) => publicArtifact(job.id, artifact)),
  };
}

function statusForError(error) {
  if (error instanceof ProviderError && error.code === "needs_login") return "needs_login";
  return "failed";
}

function serializableError(error) {
  if (error instanceof ProviderError || error instanceof ApiError) {
    return { code: error.code, message: error.message, details: error.details ?? null };
  }
  return { code: "provider_failed", message: "An unexpected provider operation failed.", details: null };
}

export class Web2ApiGateway {
  #submissions = new SerialTaskQueue();
  #controllers = new Map();
  #checks = new Map();
  #conversations = new Map();

  constructor({ dataDirectory, providers = [] }) {
    this.store = new FileJobStore(dataDirectory);
    this.providers = new Map();
    this.queues = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || typeof provider.id !== "string" || !provider.id || typeof provider.generate !== "function") {
      throw new TypeError("A provider requires id and generate(request, context).");
    }
    if (!provider.capabilities || typeof provider.capabilities !== "object") {
      throw new TypeError(`Provider ${provider.id} requires a capabilities object.`);
    }
    if (this.providers.has(provider.id)) throw new TypeError(`Provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
    const limit = provider.capabilities.scheduling?.maxConcurrency ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new TypeError("Invalid provider concurrency.");
    this.queues.set(provider.id, new SerialTaskQueue(limit));
  }

  async init() {
    await this.store.init();
    for await (const job of this.store.records()) {
      if (!["queued", "running", "cancelling"].includes(job.status)) continue;
      await this.store.update(job.id, (current) => ({
        ...current,
        status: "failed",
        error: { code: "interrupted", message: "The service stopped before this job completed. It was not automatically resent.", details: null },
        completedAt: new Date().toISOString(),
      }));
    }
    return this;
  }

  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      displayName: provider.displayName || provider.id,
      capabilities: provider.capabilities,
    }));
  }

  getProvider(id) {
    return this.providers.get(id) || null;
  }

  async checkProvider(id) {
    const provider = this.getProvider(id);
    if (!provider) throw new ApiError("provider_not_found", "Provider is not registered.", { status: 404 });
    if (!provider.capabilities.readinessCheck || typeof provider.check !== "function") {
      throw new ApiError("unsupported_feature", "This provider does not support readiness checks.", { status: 422 });
    }
    const result = (status, error = null) => ({ provider: id, status, checkedAt: new Date().toISOString(), error });
    if (this.#checks.has(id) || this.queues.get(id).size) return result("busy");
    const pending = Promise.resolve().then(async () => {
      try {
        await provider.check({ timeoutMs: 30_000 });
        return result("ready");
      } catch (error) {
        const status = error.code === "needs_login" ? "needs_login" : error.code === "profile_busy" ? "busy" : "unknown";
        // Provider causes and profile details are deliberately not public.
        return result(status, { code: status === "unknown" ? "check_failed" : error.code,
          message: status === "unknown" ? "Provider readiness could not be determined." : status === "busy" ? "Provider is busy." : "Provider login is required." });
      }
    });
    this.#checks.set(id, pending);
    try { return await pending; }
    finally { this.#checks.delete(id); }
  }

  async cancelJob(id) {
    const job = await this.store.update(id, (current) => {
      if (TERMINAL_JOB_STATUSES.has(current.status) || current.status === "cancelling") return current;
      if (current.status === "running" && !this.getProvider(current.provider)?.capabilities.cancellation?.running) {
        throw new ApiError("unsupported_feature", "This provider cannot cancel running jobs.", { status: 422 });
      }
      const queued = current.status === "queued";
      return { ...current, status: queued ? "cancelled" : "cancelling",
        cancellation: { requestedAt: new Date().toISOString(), scope: "local_execution", upstreamStopped: queued || current.submission === "not_sent" ? "not_applicable" : "unknown" },
        completedAt: queued ? new Date().toISOString() : null };
    });
    if (job.status === "cancelling") this.#controllers.get(id)?.abort(new Error("Job cancelled."));
    return publicJob(job);
  }

  async submit(payload) {
    const request = normalizeGenerationRequest(payload);
    const provider = this.getProvider(request.provider);
    if (!provider) {
      throw new ApiError("provider_not_found", `Provider ${request.provider} is not registered.`, { status: 404 });
    }
    assertProviderSupportsRequest(provider, request);

    // Serialize admission, not generation: lookup and creation must be one operation.
    return this.#submissions.enqueue(() => this.#submit(request, provider));
  }

  async #submit(request, provider) {
    const prior = await this.store.findByIdempotency(request.provider, request.idempotencyKey);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, request)) {
        throw new ApiError("idempotency_conflict", "This idempotency key was already used with a different request.", { status: 409 });
      }
      return publicJob(prior);
    }

    let previous = null;
    const id = randomUUID();
    const conversationId = request.conversationId === "new" ? id : request.conversationId;
    if (conversationId && request.conversationId !== "new") {
      for await (const entry of this.store.records()) {
        if (entry.conversationId === conversationId && (!previous || entry.turn > previous.turn)) previous = entry;
      }
      if (!previous) throw new ApiError("conversation_not_found", "Conversation was not found.", { status: 404 });
      if (previous.provider !== provider.id) throw new ApiError("conversation_provider_mismatch", "Conversation belongs to another provider.", { status: 409 });
    }
    const now = new Date().toISOString();
    const job = {
      apiVersion: API_VERSION,
      id,
      ...(conversationId ? { conversationId, turn: (previous?.turn || 0) + 1, previousJobId: previous?.id || null } : {}),
      provider: provider.id,
      status: "queued",
      request,
      output: null,
      artifacts: [],
      providerMetadata: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      submission: "not_sent",
    };
    await this.store.create(job);
    const run = () => this.queues.get(provider.id).enqueue(() => this.#run(job.id, provider, request));
    if (conversationId) {
      const prior = this.#conversations.get(conversationId) || Promise.resolve();
      const pending = prior.catch(() => {}).then(run);
      this.#conversations.set(conversationId, pending);
      void pending.finally(() => {
        if (this.#conversations.get(conversationId) === pending) this.#conversations.delete(conversationId);
      }).catch(() => {});
    } else void run().catch(() => {});
    return publicJob(job);
  }

  async #conversationUrl(job) {
    let id = job.previousJobId;
    while (id) {
      const previous = await this.store.get(id);
      if (!previous) throw new ProviderError("conversation_blocked", "Conversation history is unavailable.");
      if (previous.status === "completed") {
        const url = previous.providerMetadata?.conversationUrl;
        if (!url) throw new ProviderError("conversation_blocked", "The previous turn has no resumable conversation address.");
        return url;
      }
      if (!TERMINAL_JOB_STATUSES.has(previous.status) || previous.submission !== "not_sent") {
        throw new ProviderError("conversation_blocked", "The previous turn did not complete safely. No follow-up was sent; start a new conversation.");
      }
      id = previous.previousJobId;
    }
    return null;
  }

  async #run(jobId, provider, request) {
    await this.#checks.get(provider.id);
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("Job timed out.")), request.timeoutMs);
    try {
      const started = await this.store.update(jobId, (job) => job.status !== "queued" ? job : ({
        ...job,
        status: "running",
        startedAt: new Date().toISOString(),
        error: null,
        submission: provider.capabilities.submissionTracking ? "not_sent" : "unknown",
      }));
      if (started.status !== "running") return;
      const conversationUrl = await this.#conversationUrl(started);
      controller.signal.throwIfAborted();
      const jobDirectory = this.store.directoryFor(jobId);
      const result = await provider.generate(request, {
        jobId,
        jobDirectory,
        conversationUrl,
        signal: controller.signal,
        reportSubmission: async (submission) => {
          if (!["unknown", "confirmed"].includes(submission)) throw new TypeError("Invalid submission state.");
          await this.store.update(jobId, (job) => ({ ...job, submission }));
          controller.signal.throwIfAborted();
        },
      });
      controller.signal.throwIfAborted();
      if (!result || typeof result.text !== "string") {
        throw new ApiError("invalid_provider_result", `Provider ${provider.id} returned no text result.`, { status: 500 });
      }
      if (typeof result.outputEnforcement !== "string" || !result.outputEnforcement.trim()) {
        throw new ApiError("invalid_provider_result", `Provider ${provider.id} must report outputEnforcement.`, { status: 500 });
      }
      // Preserve generated text before attempting any fallible file collection.
      await this.store.update(jobId, (job) => ({
        ...job,
        output: { text: result.text, format: request.output.format, enforcement: result.outputEnforcement },
        providerMetadata: result.providerMetadata ?? null,
      }));
      if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) {
        throw new ApiError("invalid_provider_result", "Provider artifacts must be an array.", { status: 500 });
      }
      const artifactErrors = [];
      if (request.artifactPolicy === "collect") {
        for (const [index, candidate] of (result.artifacts ?? []).entries()) {
          controller.signal.throwIfAborted();
          let artifact;
          try {
            artifact = await stageArtifactFromFile(candidate, { jobDirectory, providerId: provider.id });
          } catch (error) {
            artifactErrors.push({ index, ...serializableError(error) });
            continue;
          }
          await this.store.update(jobId, (job) => ({ ...job, artifacts: [...job.artifacts, artifact] }));
        }
      }
      controller.signal.throwIfAborted();
      await this.store.update(jobId, (job) => ({
        ...job,
        status: job.status === "cancelling" ? "cancelled" : artifactErrors.length ? "failed" : "completed",
        error: artifactErrors.length ? {
          code: "artifact_collection_failed",
          message: "Some artifacts could not be collected. Generated text and successfully staged files are retained.",
          details: { failures: artifactErrors },
        } : null,
        completedAt: new Date().toISOString(),
      }));
    } catch (error) {
      const normalizedError = controller.signal.aborted
        ? new ProviderError("timeout", `Provider ${provider.id} exceeded the ${request.timeoutMs}ms timeout.`, { cause: error })
        : error;
      await this.store.update(jobId, (job) => ({
        ...job,
        status: job.status === "cancelling" ? "cancelled" : statusForError(normalizedError),
        error: job.status === "cancelling" ? null : serializableError(normalizedError),
        completedAt: new Date().toISOString(),
      }));
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(jobId);
    }
  }

  async getJob(id) {
    const job = await this.store.get(id);
    if (!job) throw new ApiError("job_not_found", `Job ${id} was not found.`, { status: 404 });
    return publicJob(job);
  }

  async getArtifact(id, artifactId) {
    const job = await this.store.get(id);
    if (!job) throw new ApiError("job_not_found", `Job ${id} was not found.`, { status: 404 });
    const artifact = job.artifacts?.find((entry) => entry.id === artifactId);
    if (!artifact) throw new ApiError("artifact_not_found", `Artifact ${artifactId} was not found.`, { status: 404 });
    return { jobDirectory: this.store.directoryFor(id), artifact };
  }

  async waitForTerminal(id, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.getJob(id);
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for job ${id}.`);
  }
}

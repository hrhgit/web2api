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
  #tail = Promise.resolve();

  enqueue(task) {
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => {});
    return result;
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
    this.queues.set(provider.id, new SerialTaskQueue());
  }

  async init() {
    await this.store.init();
    for await (const job of this.store.records()) {
      if (job.status !== "queued" && job.status !== "running") continue;
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

    const now = new Date().toISOString();
    const job = {
      apiVersion: API_VERSION,
      id: randomUUID(),
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
    };
    await this.store.create(job);
    void this.queues.get(provider.id).enqueue(() => this.#run(job.id, provider, request));
    return publicJob(job);
  }

  async #run(jobId, provider, request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Job timed out.")), request.timeoutMs);
    try {
      await this.store.update(jobId, (job) => ({
        ...job,
        status: "running",
        startedAt: new Date().toISOString(),
        error: null,
      }));
      const jobDirectory = this.store.directoryFor(jobId);
      const result = await provider.generate(request, {
        jobId,
        jobDirectory,
        signal: controller.signal,
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
        status: artifactErrors.length ? "failed" : "completed",
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
        status: statusForError(normalizedError),
        error: serializableError(normalizedError),
        completedAt: new Date().toISOString(),
      }));
    } finally {
      clearTimeout(timeout);
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

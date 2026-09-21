import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./contracts.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FileJobStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.jobsDirectory = path.join(this.dataDirectory, "jobs");
  }

  async init() {
    await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
  }

  directoryFor(id) {
    if (!/^[a-z0-9-]{8,128}$/iu.test(id)) {
      throw new ApiError("invalid_job_id", "Job ID contains unsupported characters.", { status: 400 });
    }
    return path.join(this.jobsDirectory, id);
  }

  fileFor(id) {
    return path.join(this.directoryFor(id), "job.json");
  }

  async #writeAtomic(filePath, record) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  async create(record) {
    const directory = this.directoryFor(record.id);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await this.#writeAtomic(path.join(directory, "job.json"), record);
    return clone(record);
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.fileFor(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new Error(`Job record ${id} is malformed.`, { cause: error });
      }
      throw error;
    }
  }

  async update(id, update) {
    const current = await this.get(id);
    if (!current) throw new ApiError("job_not_found", `Job ${id} was not found.`, { status: 404 });
    const next = await update(clone(current));
    next.updatedAt = new Date().toISOString();
    await this.#writeAtomic(this.fileFor(id), next);
    return clone(next);
  }

  async *records() {
    const entries = await readdir(this.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.get(entry.name);
      if (job) yield job;
    }
  }

  async findByIdempotency(provider, idempotencyKey) {
    if (!idempotencyKey) return null;
    for await (const job of this.records()) {
      if (job.provider === provider && job.request?.idempotencyKey === idempotencyKey) return job;
    }
    return null;
  }
}

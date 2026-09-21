import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { ApiError } from "./contracts.mjs";

function safeFileName(value) {
  const baseName = path.basename(String(value || "artifact"));
  const cleaned = baseName.replace(/[^A-Za-z0-9._ -]/gu, "_").replace(/^\.+/u, "");
  return cleaned || "artifact";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function stageArtifactFromFile(candidate, { jobDirectory, providerId }) {
  if (!candidate || typeof candidate !== "object" || typeof candidate.sourcePath !== "string") {
    throw new ApiError("invalid_provider_result", "A provider artifact must include sourcePath.", { status: 500 });
  }

  let sourcePath;
  try {
    sourcePath = await realpath(candidate.sourcePath);
  } catch (error) {
    throw new ApiError("artifact_missing", "A provider artifact could not be opened.", { status: 500, cause: error });
  }
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new ApiError("invalid_provider_result", "A provider artifact sourcePath must resolve to a regular file.", { status: 500 });
  }

  const artifactId = randomUUID();
  const fileName = safeFileName(candidate.fileName || path.basename(sourcePath));
  const artifactsDirectory = path.join(jobDirectory, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const storedFileName = `${artifactId}-${fileName}`;
  const destinationPath = path.join(artifactsDirectory, storedFileName);
  await copyFile(sourcePath, destinationPath);
  const bytes = (await stat(destinationPath)).size;

  return {
    id: artifactId,
    kind: candidate.kind === "image" ? "image" : "file",
    fileName,
    mediaType: typeof candidate.mediaType === "string" && candidate.mediaType.trim()
      ? candidate.mediaType
      : "application/octet-stream",
    bytes,
    sha256: await sha256File(destinationPath),
    provider: providerId,
    origin: {
      url: typeof candidate.originUrl === "string" ? candidate.originUrl : null,
      label: typeof candidate.originLabel === "string" ? candidate.originLabel : null,
    },
    storedPath: path.join("artifacts", storedFileName),
  };
}

export function resolveStagedArtifact(jobDirectory, artifact) {
  if (!artifact || typeof artifact.storedPath !== "string") {
    throw new ApiError("artifact_not_found", "Artifact metadata is missing.", { status: 404 });
  }
  const root = path.resolve(jobDirectory);
  const target = path.resolve(root, artifact.storedPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ApiError("invalid_artifact_path", "Artifact path escaped its job directory.", { status: 500 });
  }
  return target;
}

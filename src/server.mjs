import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { ApiError, publicError } from "./core/contracts.mjs";
import { resolveStagedArtifact } from "./core/artifacts.mjs";

const MAX_JSON_BYTES = 1024 * 1024;

function json(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new ApiError("request_too_large", `JSON request body exceeds ${MAX_JSON_BYTES} bytes.`, { status: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError("invalid_request", "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ApiError("invalid_json", "Request body must be valid JSON.", { cause: error });
  }
}

function authorize(request, token) {
  if (!token) return;
  if (request.headers.authorization !== `Bearer ${token}`) {
    throw new ApiError("unauthorized", "A valid bearer token is required.", { status: 401 });
  }
}

function attachmentHeaders(artifact) {
  const fileName = artifact.fileName.replace(/["\\\r\n]/gu, "_");
  return {
    "content-type": artifact.mediaType,
    "content-length": artifact.bytes,
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store",
  };
}

export function createApiServer({ gateway, token = process.env.WEB2API_TOKEN || null }) {
  if (!gateway) throw new TypeError("gateway is required.");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true });
        return;
      }
      authorize(request, token);
      const checkMatch = /^\/v1\/providers\/([A-Za-z0-9-]+)\/check$/u.exec(url.pathname);
      if (request.method === "POST" && checkMatch) {
        json(response, 200, await gateway.checkProvider(checkMatch[1]));
        return;
      }
      const cancelMatch = /^\/v1\/jobs\/([A-Za-z0-9-]+)\/cancel$/u.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        json(response, 200, await gateway.cancelJob(cancelMatch[1]));
        return;
      }
      if (request.method === "GET" && (url.pathname === "/v1/providers" || url.pathname === "/v1/capabilities")) {
        json(response, 200, { object: "list", data: gateway.listProviders() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/jobs") {
        const job = await gateway.submit(await readJson(request));
        json(response, 202, job);
        return;
      }
      const artifactMatch = /^\/v1\/jobs\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
      if (request.method === "GET" && artifactMatch) {
        const { jobDirectory, artifact } = await gateway.getArtifact(artifactMatch[1], artifactMatch[2]);
        const artifactPath = resolveStagedArtifact(jobDirectory, artifact);
        const artifactStats = await stat(artifactPath);
        if (!artifactStats.isFile()) throw new ApiError("artifact_not_found", "The staged artifact is missing.", { status: 404 });
        response.writeHead(200, attachmentHeaders({ ...artifact, bytes: artifactStats.size }));
        await pipeline(createReadStream(artifactPath), response);
        return;
      }
      const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
      if (request.method === "GET" && jobMatch) {
        json(response, 200, await gateway.getJob(jobMatch[1]));
        return;
      }
      throw new ApiError("not_found", "Route not found.", { status: 404 });
    } catch (error) {
      if (!response.headersSent) {
        const { status, body } = publicError(error);
        json(response, status, body);
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
}

export async function listenLocal(server, { port = 8787, host = "127.0.0.1" } = {}) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new ApiError("invalid_listen_host", "web2api only permits loopback listen hosts.");
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host });
  });
  return server.address();
}

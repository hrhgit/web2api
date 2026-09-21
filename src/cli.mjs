#!/usr/bin/env node
import process from "node:process";
import { createProviders, createWeb2ApiApp } from "./app.mjs";
import { createApiServer, listenLocal } from "./server.mjs";

function usage() {
  return `web2api commands:
  web2api serve [--port 8787]
  web2api providers
  web2api login <provider-id>`;
}

function readPort(args) {
  const index = args.indexOf("--port");
  if (index === -1) return Number(process.env.WEB2API_PORT || 8787);
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a TCP port from 1 through 65535.");
  return port;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const providers = createProviders();
  if (command === "providers") {
    process.stdout.write(`${JSON.stringify(providers.map(({ id, displayName, capabilities }) => ({ id, displayName, capabilities })), null, 2)}\n`);
    return;
  }
  if (command === "login") {
    const provider = providers.find((entry) => entry.id === args[0]);
    if (!provider) throw new Error(`Unknown provider: ${args[0] || "(missing)"}.`);
    if (typeof provider.login !== "function") throw new Error(`Provider ${provider.id} has no browser login flow.`);
    process.stdout.write(`${JSON.stringify(await provider.login(), null, 2)}\n`);
    return;
  }
  if (command === "serve") {
    const { gateway, dataDirectory } = await createWeb2ApiApp({ providers });
    const server = createApiServer({ gateway });
    const address = await listenLocal(server, { port: readPort(args) });
    const port = typeof address === "object" && address ? address.port : readPort(args);
    process.stdout.write(`${JSON.stringify({ event: "listening", url: `http://127.0.0.1:${port}`, dataDirectory })}\n`);
    const close = () => server.close(() => process.exit(0));
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }
  throw new Error(`Unknown command: ${command}.\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

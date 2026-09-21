import os from "node:os";
import path from "node:path";
import { Web2ApiGateway } from "./core/gateway.mjs";
import { GeminiWebProvider } from "./providers/gemini-web.mjs";
import { MockWebProvider } from "./providers/mock-web.mjs";
import { OpenAIWebProvider } from "./providers/openai-web.mjs";

export function defaultDataDirectory() {
  return path.join(os.homedir(), ".web2api", "data");
}

export function createProviders() {
  return [new MockWebProvider(), new GeminiWebProvider(), new OpenAIWebProvider()];
}

export async function createWeb2ApiApp({ dataDirectory = process.env.WEB2API_DATA_DIR || defaultDataDirectory(), providers = null } = {}) {
  const registeredProviders = providers ?? createProviders();
  const gateway = new Web2ApiGateway({ dataDirectory, providers: registeredProviders });
  await gateway.init();
  return { gateway, dataDirectory: gateway.store.dataDirectory };
}

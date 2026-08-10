import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startOpenAIGateway } from "../harnesses/pi/openai-gateway";
import { requireOpenAIKey, resolveLocalPiOptions } from "./options";

const options = resolveLocalPiOptions();
const apiKey = requireOpenAIKey(options.useOpenAI);
const bearerPath = resolve(options.root, ".pocketcoder/local/secrets/pi-gateway/bearer");
let clientBearer: string;
try {
  clientBearer = (await readFile(bearerPath, "utf8")).trim();
} catch {
  throw new Error(`local runtime is not prepared; missing ${bearerPath}`);
}
if (!clientBearer) throw new Error(`local gateway bearer is empty: ${bearerPath}`);

const gateway = startOpenAIGateway({
  apiKey,
  clientBearer,
  organization: process.env.OPENAI_ORGANIZATION,
  project: process.env.OPENAI_PROJECT,
  port: options.gatewayPort,
});
console.log(`OpenAI gateway listening on http://127.0.0.1:${gateway.port}`);

await new Promise<void>((resolveShutdown) => {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    gateway.stop(true);
    resolveShutdown();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

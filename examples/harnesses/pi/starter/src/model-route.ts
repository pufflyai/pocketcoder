import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The deployment's model gateway (agentgateway in reference deployments). PocketCoder ships no
// gateway: it only delivers the workspace-scoped, expiring bearer as a runtime credential file.
export interface ModelRoute {
  url: string;
  model: string;
  api: "openai-completions" | "openai-responses";
  bearerFile: string;
  contextWindow: number;
  maxTokens: number;
}

export const PROVIDER = "pocketcoder-gateway";
// Pi expands `$NAME` in models.json from its environment, so the bearer never lands on disk.
export const BEARER_ENV = "PI_GATEWAY_BEARER";

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function routeFromEnv(env: Record<string, string | undefined>): ModelRoute {
  const api = env.PI_GATEWAY_API ?? "openai-completions";
  if (api !== "openai-completions" && api !== "openai-responses")
    throw new Error("PI_GATEWAY_API must be openai-completions or openai-responses");
  return {
    url: required(env, "PI_GATEWAY_URL"),
    model: required(env, "PI_GATEWAY_MODEL"),
    api,
    bearerFile: required(env, "PI_GATEWAY_BEARER_FILE"),
    contextWindow: positive(env.PI_GATEWAY_CONTEXT_WINDOW ?? "128000", "PI_GATEWAY_CONTEXT_WINDOW"),
    maxTokens: positive(env.PI_GATEWAY_MAX_TOKENS ?? "16384", "PI_GATEWAY_MAX_TOKENS"),
  };
}

export async function writeModelConfig(agentDir: string, route: ModelRoute) {
  await mkdir(agentDir, { recursive: true });
  const provider = {
    name: "Deployment model gateway",
    baseUrl: route.url,
    api: route.api,
    apiKey: `$${BEARER_ENV}`,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [
      {
        id: route.model,
        name: route.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: route.contextWindow,
        maxTokens: route.maxTokens,
      },
    ],
  };
  await Bun.write(
    join(agentDir, "models.json"),
    `${JSON.stringify({ providers: { [PROVIDER]: provider } }, null, 2)}\n`,
  );
}

// Read for every turn: the credential owner renews the file before it expires.
export async function readBearer(route: ModelRoute) {
  const bearer = (await readFile(route.bearerFile, "utf8")).split("\n")[0]?.trim();
  if (!bearer) throw new Error("The model gateway credential is missing.");
  return bearer;
}

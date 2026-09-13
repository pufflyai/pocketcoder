import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface ResumeGatewayInput {
  url: string;
  model: string;
  api: "openai-completions" | "openai-responses";
  bearer: string;
}

export async function preparePersistentPi(agentDir: string, gateway: ResumeGatewayInput) {
  await mkdir(agentDir, { recursive: true });
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "resume-gateway": {
          baseUrl: gateway.url,
          api: gateway.api,
          apiKey: gateway.bearer,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: gateway.model,
              name: gateway.model,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  return [
    "--provider",
    "resume-gateway",
    "--model",
    gateway.model,
    "--session-dir",
    "/state/pi",
    "--continue",
    "--extension",
    "/opt/pi/agentapi-compat.ts",
    "--approve",
    "--offline",
  ];
}

if (import.meta.main) {
  const input = JSON.parse(process.env.POCKETCODER_LAUNCH_INPUT ?? "{}") as {
    gateway: ResumeGatewayInput;
  };
  const agentDir = "/home/agent/.pi/agent";
  const args = await preparePersistentPi(agentDir, input.gateway);
  const child = Bun.spawn(["/opt/pi/node_modules/.bin/pi", ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, POCKETCODER_LAUNCH_INPUT: undefined },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.exit(await child.exited);
}

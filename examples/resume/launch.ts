import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment } from "./environment";

export function resumeInvocation(input: {
  baseUrl: string;
  key: string;
  workspaceId: string;
  controlUrl: string;
  controlKey: string;
  check: boolean;
}) {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return {
    command: [
      process.execPath,
      join(dirname(entry), "cli.js"),
      "--provider",
      "pocketcoder-agentapi",
      "--model",
      "remote-agent",
      "--api-key",
      "local-ui",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-session",
      "--offline",
      "--extension",
      join(import.meta.dir, "extension.ts"),
      ...(input.check ? ["--mode", "rpc"] : []),
    ],
    env: {
      ...isolatedEnvironment(),
      ...(input.check ? { POCKETCODER_RESUME_RPC: "1" } : {}),
      POCKETCODER_URL: input.baseUrl,
      POCKETCODER_KEY: input.key,
      POCKETCODER_WORKSPACE_ID: input.workspaceId,
      POCKETCODER_RESUME_CONTROL_URL: input.controlUrl,
      POCKETCODER_RESUME_CONTROL_KEY: input.controlKey,
    },
  };
}

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, ...options] = process.argv.slice(2);
if (mode !== "echo" && mode !== "pi" && mode !== "onefin") throw new Error("Choose echo, pi, or onefin");
// An image that extends this one names the extra environment its agent reads: `--env NAME`.
const extraEnvironment = options.flatMap((option, index) => (option === "--env" ? [options[index + 1]] : []));
if (extraEnvironment.some((name) => !name || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)))
  throw new Error("--env needs an upper-case environment variable name");
const runtime = "/opt/pocketcoder/supervisor.js";
const artifact = mode === "onefin" ? "/opt/pocketcoder/onefin.js" : runtime;
const command =
  mode === "onefin"
    ? ["/usr/local/bin/bun", artifact]
    : [
        "/usr/local/bin/bun",
        runtime,
        "session",
        "serve",
        mode,
        ...(mode === "pi" ? ["--", "/usr/local/bin/run-pi"] : []),
      ];
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const descriptor = {
  format: "pocketcoder.image/v1",
  codeRoots: ["/opt", "/usr", "/bin", "/sbin", "/lib"],
  runtime: {
    digest: digest(runtime),
    protocol: "pocketcoder.workload/v1",
    artifact: runtime,
    command: ["/usr/local/bin/bun", runtime, "supervise", "--launch-input", "/run/pocketcoder/input"],
    entrypoint: ["/usr/local/bin/docker-entrypoint.sh"],
    capabilities: ["workspace-services", ...(mode === "pi" ? ["explicit-publication"] : [])],
  },
  checkpoint: {
    artifact: "/opt/pocketcoder/quiesce.ts",
    digest: digest("/opt/pocketcoder/quiesce.ts"),
    command: ["/usr/local/bin/bun", "/opt/pocketcoder/quiesce.ts"],
    environment: [],
    ownsServiceDescendants: true,
  },
  adapters: {
    session: {
      kind: "service",
      baseUrl: "http://127.0.0.1:3284",
      healthPath: "/healthz",
      digest: digest(artifact),
      protocol: "pocketcoder.execution/v1",
      artifact,
      command,
      ...(mode === "pi" ? { cwd: "/workspace" } : {}),
      capabilities: [
        "request-lookup",
        "deduplicated-accept",
        "targeted-cancel",
        "unknown-outcome",
        "parallel-conversations",
        "immutable-inputs",
        ...(mode === "pi" ? ["history-seed", "explicit-publication"] : []),
      ],
      environment: [
        "POCKETCODER_SESSION_DIRECTORY",
        "ONEFIN_AGENT_GATEWAY_URL",
        "ONEFIN_AGENT_MODEL",
        "PI_GATEWAY_URL",
        "PI_GATEWAY_MODEL",
        "PI_GATEWAY_API",
        "PI_GATEWAY_PROVIDER",
        "PI_GATEWAY_BEARER_FILE",
        "PI_GATEWAY_CONTEXT_WINDOW",
        "PI_GATEWAY_MAX_TOKENS",
        "PI_CODING_AGENT_DIR",
        "HOME",
        "PI_WORKSPACE_DIR",
        ...extraEnvironment,
      ],
    },
  },
};
writeFileSync("/opt/pocketcoder/workload.json", `${JSON.stringify(descriptor, null, 2)}\n`);

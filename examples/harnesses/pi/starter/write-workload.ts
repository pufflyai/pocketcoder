// Runs during the image build. It hashes the installed supervisor and Pi adapter and writes the
// image manifest the driver verifies before readiness. Copy the printed digests into the template.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const RUNTIME = "/opt/pocketcoder/supervisor.js";
const ADAPTER = "/opt/pocketcoder/pi-adapter.js";
const entrypoint = JSON.parse(process.argv[2] ?? "[]") as string[];
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

const manifest = {
  format: "pocketcoder.image/v1",
  codeRoots: ["/opt", "/usr", "/bin", "/sbin", "/lib", ...(existsSync("/lib64") ? ["/lib64"] : [])],
  runtime: {
    digest: digest(RUNTIME),
    protocol: "pocketcoder.workload/v1",
    artifact: RUNTIME,
    command: ["/usr/local/bin/bun", RUNTIME, "supervise", "--launch-input", "/run/pocketcoder/input"],
    entrypoint,
  },
  adapters: {
    main: {
      kind: "service",
      baseUrl: "http://127.0.0.1:3284",
      healthPath: "/status",
      digest: digest(ADAPTER),
      protocol: "pocketcoder.execution/v1",
      artifact: ADAPTER,
      // Proved by the adapter: same-ID accept replays, lookup, per-turn cancel, explicit file
      // publication and separate Pi runs for different sessions.
      capabilities: [
        "deduplicated-accept",
        "request-lookup",
        "targeted-cancel",
        "explicit-publication",
        "unknown-outcome",
        "parallel-conversations",
        "immutable-inputs",
        "history-seed",
      ],
      command: ["bun", ADAPTER],
      environment: [
        "PI_ADAPTER_PORT",
        "PI_PUBLICATION_MAX_BYTES",
        "PI_GATEWAY_URL",
        "PI_GATEWAY_MODEL",
        "PI_GATEWAY_API",
        "PI_GATEWAY_BEARER_FILE",
        "PI_GATEWAY_CONTEXT_WINDOW",
        "PI_GATEWAY_MAX_TOKENS",
      ],
    },
  },
};
writeFileSync("/opt/pocketcoder/workload.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ runtimeDigest: manifest.runtime.digest, adapterDigest: manifest.adapters.main.digest }));

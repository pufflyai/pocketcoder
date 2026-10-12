import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openControllerStore } from "../bootstrap/controller-store";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";

const fixtureDirectory = process.env.PC_DISCOVERY_FIXTURE;
if (!fixtureDirectory) throw new Error("Missing discovery fixture directory.");
const directory = fixtureDirectory;
const messages: string[] = [];
let offNodeConfig: string | undefined;
if (process.env.PC_DISCOVERY_MODE === "existing") {
  const existing = await openControllerStore(join(directory, "data"));
  await existing.store.close();
}
if (process.env.PC_DISCOVERY_MODE === "init-failure") {
  const keys = join(directory, "data", "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  for (const [index, name] of ["auth-pepper", "event-signing-key", "secret-key"].entries())
    await writeFile(join(keys, name), Buffer.alloc(32, 7 + index), { mode: 0o600 });
  const key = join(directory, "outer-key");
  await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
  const storage = await Bun.file(join(directory, "storage.json")).json();
  offNodeConfig = join(directory, "off-node.json");
  await writeFile(
    offNodeConfig,
    JSON.stringify({
      accountId: crypto.randomUUID(),
      encryptionKeyFile: key,
      storage,
    }),
    { mode: 0o600 },
  );
}
if (process.env.PC_DISCOVERY_MODE === "invalid-keys") {
  const keys = join(directory, "data", "keys");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  await writeFile(join(keys, "auth-pepper"), Buffer.alloc(4), { mode: 0o600 });
  for (const name of ["event-signing-key", "secret-key"])
    await writeFile(join(keys, name), Buffer.alloc(32, 9), { mode: 0o600 });
}
if (process.env.PC_DISCOVERY_MODE?.startsWith("checkpoint-"))
  await writeFile(join(directory, "checkpoint-file"), "owned-file", { mode: 0o600 });
async function run() {
  const running = await startPocketCoderServer(
    {
      ...loadConfig({
        POCKETCODER_DIR: join(directory, "data"),
        ...(offNodeConfig ? { POCKETCODER_OFF_NODE_CONFIG: offNodeConfig } : {}),
        ...(process.env.PC_DISCOVERY_MODE?.startsWith("checkpoint-")
          ? {
              POCKETCODER_STORAGE_BACKEND: "filesystem",
              POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "live"),
              POCKETCODER_CHECKPOINT_DIR: join(directory, "checkpoint-file"),
            }
          : {}),
      }),
      listenPort: 0,
      agentPort: 0,
    },
    {
      log: (message) => {
        messages.push(message);
        if (message === "provider discovery started")
          writeFileSync(
            join(directory, "spawn.json"),
            JSON.stringify({
              epochMs: Date.now(),
              databaseExists: existsSync(join(directory, "data", "db", "PG_VERSION")),
              keysExist: existsSync(join(directory, "data", "keys", "auth-pepper")),
            }),
          );
        if (message === "coordinator lease acquired")
          writeFileSync(join(directory, "lease.json"), JSON.stringify({ epochMs: Date.now() }));
        if (message === "startup cleanup started") {
          writeFileSync(join(directory, "error.json"), JSON.stringify({ epochMs: Date.now() }));
          if (process.env.PC_DISCOVERY_MODE === "checkpoint-log-failure") throw new Error("owned log sink failed");
        }
      },
    },
  );
  try {
    await Bun.write(
      join(directory, "result.json"),
      JSON.stringify({
        status: (await fetch(`${running.url}/readyz`)).status,
        messages,
      }),
    );
  } finally {
    await running.stop();
  }
}

const owner = process.env.PC_DISCOVERY_MODE === "busy" ? await openControllerStore(join(directory, "data")) : undefined;
try {
  await run();
} finally {
  await owner?.store.close();
}

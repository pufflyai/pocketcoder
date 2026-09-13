import { chmod, rename, rm } from "node:fs/promises";
import { connectionFile } from "./connection";
import { endSessionAt } from "./expiry";
import { IsolatedStack } from "./stack";
import { startSession } from "./start-session";

const directory = process.argv[2] ?? "";
if (!directory) throw new Error("State directory is required");
const idleSeconds = Number(process.argv[3]);
const check = process.argv.includes("--check-model");
const stack = new IsolatedStack();
let closing: Promise<void> | undefined;
let cancelExpiry = () => {};
async function close() {
  cancelExpiry();
  closing ??= (async () => {
    await stack.close();
    await rm(connectionFile(directory), { force: true });
  })();
  return closing;
}
function stop() {
  void close().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);

try {
  const { api, session } = await startSession(stack, idleSeconds, check);
  cancelExpiry = endSessionAt(api.expiresAt, stop);
  const control = session.controlServer(stop);
  stack.cleanups.push(async () => control.close());
  const path = `${connectionFile(directory)}.tmp`;
  await Bun.write(
    path,
    JSON.stringify({
      baseUrl: api.baseUrl,
      key: api.key,
      controlUrl: control.url,
      controlKey: control.key,
      expiresAt: api.expiresAt.toISOString(),
    }),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  await rename(path, connectionFile(directory));
  console.log("Ready. Pi may disconnect while this isolated session stays available.");
} catch (error) {
  console.error(error);
  await close();
  process.exit(1);
}

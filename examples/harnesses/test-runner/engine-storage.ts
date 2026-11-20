import { existsSync } from "node:fs";
import { chown, mkdir } from "node:fs/promises";

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Engine storage setup failed: ${command[0]}`);
}

export async function prepareEngineStorage() {
  await mkdir("/workspace/engine", { recursive: true });
  // Kata shares emptyDir over virtiofs, which cannot back overlay2. The sparse
  // ext4 disk stays on workspace storage; its loop device belongs to this VM.
  for (const [path, kind, major, minor] of [
    ["/dev/loop-control", "c", "10", "237"],
    ["/dev/loop0", "b", "7", "0"],
  ] as const) {
    if (!existsSync(path)) await run(["mknod", path, kind, major, minor]);
  }
  await run(["truncate", "-s", "32G", "/workspace/engine.ext4"]);
  await run(["mkfs.ext4", "-F", "/workspace/engine.ext4"]);
  await run(["mount", "-o", "loop", "/workspace/engine.ext4", "/workspace/engine"]);
  for (const name of ["docker", "tmp"]) {
    await mkdir(`/workspace/engine/${name}`, { recursive: true });
    await mkdir(`/workspace/${name}`, { recursive: true });
    await run(["mount", "--bind", `/workspace/engine/${name}`, `/workspace/${name}`]);
  }
  await chown("/workspace/tmp", 10001, 10001);
}

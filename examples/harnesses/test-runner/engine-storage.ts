import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Engine storage setup failed: ${command[0]}`);
}

export async function prepareEngineStorage() {
  await mkdir("/workspace/docker", { recursive: true });
  // Kata shares emptyDir over virtiofs, which cannot back overlay2. The sparse
  // ext4 disk stays on workspace storage; its loop device belongs to this VM.
  for (const [path, kind, major, minor] of [
    ["/dev/loop-control", "c", "10", "237"],
    ["/dev/loop0", "b", "7", "0"],
  ] as const) {
    if (!existsSync(path)) await run(["mknod", path, kind, major, minor]);
  }
  await run(["truncate", "-s", "32G", "/workspace/docker.ext4"]);
  await run(["mkfs.ext4", "-F", "/workspace/docker.ext4"]);
  await run(["mount", "-o", "loop", "/workspace/docker.ext4", "/workspace/docker"]);
}

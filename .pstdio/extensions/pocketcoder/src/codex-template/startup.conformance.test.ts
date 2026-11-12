import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../../..");

async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`${args.join(" ")}\n${stderr}\n${stdout}`);
  return stdout.trim();
}

test("the Codex template keeps its real Prompt Studio server alive and starts Codex", async () => {
  const id = randomUUID();
  const base = `pocketcoder-codex-base:test-${id}`;
  const image = `pocketcoder-codex:test-${id}`;
  const container = `pocketcoder-codex-test-${id}`;
  const work = await mkdtemp(join(tmpdir(), "pocketcoder-codex-work-"));
  // The template user is UID 10001, like the controller's per-machine work mount.
  await chmod(work, 0o777);
  let built = false;
  try {
    await command([
      "bun",
      "build",
      "packages/supervisor/src/index.ts",
      "--target",
      "bun",
      "--outdir",
      "deploy/image/dist",
    ]);
    await command(["docker", "build", "-t", base, "deploy/image"]);
    await command(["docker", "build", "--build-arg", `WORKSPACE_IMAGE=${base}`, "-t", image, import.meta.dir]);
    built = true;
    await command([
      "docker",
      "run",
      "-d",
      "--name",
      container,
      "--cpus",
      "2",
      "--memory",
      "2g",
      "-p",
      "127.0.0.1::19841",
      // Match how the controller launches this template: read-only root, in-memory /tmp, disk-backed /work.
      "--read-only",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001,mode=0700",
      "--mount",
      `type=bind,src=${work},dst=/work`,
      "--entrypoint",
      "bun",
      image,
      "/opt/pstdio-tools/start.ts",
    ]);
    const address = await command(["docker", "port", container, "19841/tcp"]);
    const deadline = Date.now() + 240_000;
    let connection: { state: string; versions: { pstdio: string; codex: string } } | undefined;
    while (Date.now() < deadline) {
      const running = await command(["docker", "inspect", container, "--format", "{{.State.Running}}"]);
      if (running !== "true")
        throw new Error(`Template exited before readiness.\n${await command(["docker", "logs", container])}`);
      const response = await fetch(`http://${address}/connection`).catch(() => undefined);
      if (response?.ok) {
        connection = await response.json();
        break;
      }
      await Bun.sleep(100);
    }
    expect(connection?.state).toBe("needs-enrollment");
    expect(connection?.versions.pstdio).toBe("0.47.0-nightly.20261109030238");
    expect(connection?.versions.codex).toContain("0.167.0");

    const codex = Bun.spawn(["docker", "exec", "-i", container, "codex", "app-server", "--listen", "stdio://"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      codex.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "pocketcoder_test", version: "1.0.0" } },
        })}\n`,
      );
      const reader = codex.stdout.getReader();
      let output = "";
      while (!output.includes("\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Codex exited before its initialize reply.");
        output += new TextDecoder().decode(part.value);
      }
      const reply = JSON.parse(output.split("\n")[0]);
      expect(reply.id).toBe(1);
      expect(reply.error).toBeUndefined();
      expect(reply.result.userAgent).toContain("pocketcoder_test/0.167.0");
      codex.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      await codex.stdin.end();
      expect(await codex.exited).toBe(0);
    } finally {
      codex.kill();
      await codex.exited;
    }

    expect((await fetch(`http://${address}/connection`)).ok).toBe(true);
    expect(await command(["docker", "inspect", container, "--format", "{{.Config.User}}"])).toBe("10001:10001");
    await command([
      "docker",
      "exec",
      container,
      "bun",
      "--eval",
      'const fs = await import("node:fs/promises"); await fs.mkdir("/work/cleanup-owned/private", {recursive:true, mode:0o700}); await fs.writeFile("/work/cleanup-owned/private/data", "fixture");',
    ]);
    // Docker Desktop bind mounts do not enforce Linux UID ownership.
    if (process.platform === "linux") {
      await expect(
        command([
          "docker",
          "exec",
          "--user",
          "10002:10002",
          container,
          "bun",
          "--eval",
          'await import("node:fs/promises").then(fs => fs.rm("/work/cleanup-owned", {recursive:true}));',
        ]),
      ).rejects.toThrow("EACCES");
    }
    await command(["docker", "stop", "-t", "10", container]);
    expect(await command(["docker", "inspect", container, "--format", "{{.State.Running}}"])).toBe("false");
  } finally {
    await command(["docker", "rm", "-f", container]).catch(() => undefined);
    try {
      // Stop writers before clearing files, including when startup or an assertion failed.
      // The test also cleans up after shutdown. Linux hosts may not own UID 10001's files.
      if (built) {
        await command([
          "docker",
          "run",
          "--rm",
          "--user",
          "10001:10001",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--mount",
          `type=bind,src=${work},dst=/work`,
          "--entrypoint",
          "bun",
          image,
          "--eval",
          'const fs = await import("node:fs/promises"); for (const name of await fs.readdir("/work")) await fs.rm("/work/" + name, {recursive:true, force:true});',
        ]);
        expect(await readdir(work)).toEqual([]);
      }
    } finally {
      await command(["docker", "image", "rm", image, base]).catch(() => undefined);
      await rm(work, { recursive: true, force: true });
    }
  }
}, 360_000);

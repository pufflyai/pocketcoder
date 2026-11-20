import { chmod, chown, mkdir } from "node:fs/promises";
import { prepareEngineCgroups } from "./engine-cgroups";
import { prepareEngineLoopback } from "./engine-loopback";
import { prepareEngineStorage } from "./engine-storage";

// This entrypoint runs only in an operator-authorized Kata VM. The daemon and the
// test processes see the same paths; no socket or daemon is shared with the node.
if (process.getuid?.() !== 0) throw new Error("The container engine needs the VM's root user");
await prepareEngineCgroups();
await prepareEngineLoopback();
await mkdir("/workspace/home", { recursive: true });
await chown("/workspace/home", 10001, 10001);
await prepareEngineStorage();
await mkdir("/workspace/docker-run", { recursive: true });
const daemon = Bun.spawn(
  [
    "dockerd",
    "--host=unix:///workspace/docker-run/docker.sock",
    "--group=10001",
    "--data-root=/workspace/docker",
    "--exec-root=/workspace/docker-run",
    "--pidfile=/workspace/docker-run/docker.pid",
    "--storage-driver=overlay2",
  ],
  {
    stdout: Bun.file("/workspace/docker.log"),
    stderr: Bun.file("/workspace/docker-error.log"),
  },
);
const deadline = Date.now() + 60_000;
let ready = false;
while (!ready && Date.now() < deadline && daemon.exitCode === null) {
  const probe = Bun.spawn(["docker", "--host=unix:///workspace/docker-run/docker.sock", "info"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  ready = (await probe.exited) === 0;
  if (!ready) await Bun.sleep(200);
}
if (!ready) {
  daemon.kill("SIGKILL");
  process.stderr.write(await Bun.file("/workspace/docker-error.log").text());
  throw new Error("The workspace Docker daemon did not become ready");
}
await chmod("/workspace/docker-run", 0o711);
process.setgid?.(10001);
process.setuid?.(10001);
const command = process.argv.slice(2);
if (process.env.POCKETCODER_VIRTUAL_DISPLAY === "1")
  command.unshift(
    "/usr/bin/xvfb-run",
    "-a",
    "--error-file=/workspace/xvfb.log",
    "/usr/local/bin/bun",
    "/opt/pocketcoder/display-session.js",
  );
const supervisor = Bun.spawn(command, {
  detached: true,
  env: { ...process.env, HOME: "/workspace/home", DOCKER_HOST: "unix:///workspace/docker-run/docker.sock" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
// The display wrapper and runtime must stop together.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    try {
      process.kill(-supervisor.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
process.exit(await supervisor.exited);

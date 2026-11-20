import { chmod, chown, mkdir } from "node:fs/promises";
import { prepareEngineStorage } from "./engine-storage";

// This entrypoint runs only in an operator-authorized Kata VM. The daemon and the
// test processes see the same paths; no socket or daemon is shared with the node.
if (process.getuid?.() !== 0) throw new Error("The container engine needs the VM's root user");
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
const supervisor = Bun.spawn(process.argv.slice(2), {
  env: { ...process.env, HOME: "/workspace/home", DOCKER_HOST: "unix:///workspace/docker-run/docker.sock" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => supervisor.kill(signal));
process.exit(await supervisor.exited);

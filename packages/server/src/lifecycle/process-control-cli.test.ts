// Proves the actual CLI caller joins its exact synthetic controller process without a tenant key.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processControlCliFixtureSource } from "./process-control-cli-fixture";

test("server quiesce uses the existing exact managed process identity and private transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctl-"));
  const instanceId = crypto.randomUUID();
  const controllerCwd = join(root, "controller-cwd");
  await mkdir(controllerCwd, { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), POCKETCODER_STATE_DIR: root };
  const child = Bun.spawn([process.execPath, "--no-env-file", processControlCliFixtureSource, instanceId, root], {
    cwd: controllerCwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    const original = JSON.parse(Buffer.from(ready.value as Uint8Array).toString("utf8"));
    expect(original.pid).toBe(child.pid);
    await writeFile(
      join(root, "server.json"),
      JSON.stringify({
        version: 1,
        pid: child.pid,
        instanceToken: instanceId,
        url: original.url,
        startedAt: new Date().toISOString(),
        configFingerprint: "synthetic",
        logPath: join(root, "synthetic.log"),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const envFile = join(root, "empty.env");
    await writeFile(envFile, "", { flag: "wx", mode: 0o600 });
    const cliSource = resolve(import.meta.dir, "../../../cli/src/index.ts");
    const caller = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cliSource,
        "server",
        "quiesce",
        "--timeout-seconds",
        "3",
        "--env-file",
        envFile,
      ],
      {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      caller.exited,
      new Response(caller.stdout).text(),
      new Response(caller.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    console.log(JSON.stringify({ ownedCallerPid: caller.pid, callerExitCode: code, controllerPid: child.pid }));
    expect(JSON.parse(stdout)).toEqual({ instanceId, pid: child.pid, outcome: "userspace_quiescent" });
    expect(child.exitCode).toBeNull();
    await expect(fetch(`${original.url}/livez`)).rejects.toThrow();
  } finally {
    child.kill("SIGTERM");
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (stderr) console.error(stderr);
    console.log(JSON.stringify({ controllerPid: child.pid, controllerExitCode: exitCode, cleanupSignal: "SIGTERM" }));
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    await rm(root, { recursive: true });
  }
});

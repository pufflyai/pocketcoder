import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

async function run(...command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`);
  return stdout.trim();
}

// Run inside the review image through engine.ts on a real Kata worker. The
// named resources remain alive so the operator can verify VM isolation/deletion.
test("the Kata workspace supports private IPv6 loopback listeners", async () => {
  const server = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("loopback-ok") });
  try {
    expect(await (await fetch(`http://[::1]:${server.port}/`)).text()).toBe("loopback-ok");
  } finally {
    server.stop(true);
  }
});

test("the review runtime supplies the pinned Bun package runner", async () => {
  expect(await run("bunx", "--version")).toBe(Bun.version);
});

test("the review worker configures the desktop sandbox inside its VM", async () => {
  expect(process.getuid?.()).toBe(10001);
  const directory = await mkdtemp("/workspace/desktop-sandbox-");
  const sandbox = `${directory}/chrome-sandbox`;
  try {
    await writeFile(sandbox, "sandbox fixture");
    await run("sudo", "-n", "chown", "root:root", sandbox);
    await run("sudo", "-n", "chmod", "4755", sandbox);
    const file = await stat(sandbox);
    expect(file.uid).toBe(0);
    expect(file.mode & 0o7777).toBe(0o4755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the review worker supplies a private X11 display and window manager", async () => {
  const display = process.env.DISPLAY ?? "";
  expect(display).toMatch(/^:\d+$/);
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
  expect((await stat(socket)).isSocket()).toBe(true);
  expect(await run("xprop", "-root", "_NET_SUPPORTING_WM_CHECK")).toMatch(/window id # 0x[0-9a-f]*[1-9a-f]/i);
});

test("the workspace init reaps orphaned test processes", async () => {
  const pid = Number(await run("sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 2000;
  while (alive() && Date.now() < deadline) await Bun.sleep(10);
  expect(alive()).toBe(false);
});

test("the Kata workspace builds and runs nested containers with disk storage, bind mounts and Compose", async () => {
  expect(process.getuid?.()).toBe(10001);
  expect(process.env.DOCKER_HOST).toBe("unix:///workspace/docker-run/docker.sock");
  expect(await readFile("/proc/mounts", "utf8")).toMatch(/ \/workspace\/docker ext4 /);
  expect(await readFile("/proc/mounts", "utf8")).toMatch(/ \/workspace\/tmp ext4 /);
  expect(await run("docker", "info", "--format", "{{.Driver}}")).toBe("overlay2");
  expect(await run("docker", "info", "--format", "{{.DockerRootDir}}")).toBe("/workspace/docker");
  expect(await run("docker", "buildx", "version")).toContain("buildx");

  const root = "/workspace/engine-proof";
  const owner = process.env.ROLE ?? "engine-test";
  await mkdir(root, { recursive: true });
  await mkdir("/workspace/tmp", { recursive: true });
  await writeFile(`${root}/owner`, owner);
  await writeFile(
    `${root}/Dockerfile`,
    'FROM alpine:3.22\nARG OWNER\nRUN printf "%s" "$OWNER" > /owner\nCMD ["cat", "/owner"]\n',
  );
  process.env.DOCKER_BUILDKIT = "1";
  await run("docker", "build", "--no-cache", "--build-arg", `OWNER=${owner}`, "-t", "pc195-engine-check:local", root);
  expect(await run("docker", "run", "--rm", "--init", "pc195-engine-check:local")).toBe(owner);
  expect(
    await run(
      "docker",
      "run",
      "--rm",
      "--memory=32m",
      "--pids-limit=32",
      "pc195-engine-check:local",
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max",
    ),
  ).toBe("33554432\n32");
  expect(
    await run(
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${root},dst=/proof,readonly`,
      "pc195-engine-check:local",
      "cat",
      "/proof/owner",
    ),
  ).toBe(owner);

  await run("docker", "network", "create", "pc195-smoke");
  await run(
    "docker",
    "run",
    "-d",
    "--name",
    "pc195-sentinel",
    "--network",
    "pc195-smoke",
    "--label",
    `pc195.owner=${owner}`,
    "pc195-engine-check:local",
    "nc",
    "-lk",
    "-p",
    "8080",
    "-e",
    "/bin/cat",
    "/owner",
  );
  expect(
    await run(
      "docker",
      "run",
      "--rm",
      "--network",
      "pc195-smoke",
      "pc195-engine-check:local",
      "nc",
      "-w",
      "3",
      "pc195-sentinel",
      "8080",
    ),
  ).toBe(owner);
  await run("docker", "volume", "create", "pc195-volume");
  await run(
    "docker",
    "run",
    "--rm",
    "--mount",
    "type=volume,src=pc195-volume,dst=/data",
    "pc195-engine-check:local",
    "sh",
    "-c",
    "cp /owner /data/owner",
  );
  expect(
    await run(
      "docker",
      "run",
      "--rm",
      "--mount",
      "type=volume,src=pc195-volume,dst=/data",
      "pc195-engine-check:local",
      "cat",
      "/data/owner",
    ),
  ).toBe(owner);

  await writeFile(
    `${root}/compose.yaml`,
    JSON.stringify({
      services: {
        probe: {
          image: "pc195-compose-check:local",
          init: true,
          build: { context: ".", args: { OWNER: owner } },
          volumes: ["./owner:/proof:ro"],
          command: ["cat", "/proof"],
        },
      },
    }),
  );
  const compose = ["docker", "compose", "--project-name", "pc195", "--file", `${root}/compose.yaml`];
  await run(...compose, "build", "--no-cache");
  expect(await run(...compose, "run", "--rm", "probe")).toBe(owner);
  await run(...compose, "down", "--volumes");
  console.log(`PC195_ENGINE_PASS role=${owner} daemon=${await run("docker", "info", "--format", "{{.ID}}")}`);
}, 120_000);

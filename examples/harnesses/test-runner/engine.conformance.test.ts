import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
test("the Kata workspace builds and runs nested containers with disk storage, bind mounts and Compose", async () => {
  expect(process.getuid?.()).toBe(10001);
  expect(process.env.DOCKER_HOST).toBe("unix:///workspace/docker-run/docker.sock");
  expect(await readFile("/proc/mounts", "utf8")).toMatch(/ \/workspace\/docker ext4 /);
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

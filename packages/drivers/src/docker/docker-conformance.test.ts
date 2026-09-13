import { describe, expect, test } from "bun:test";

const conformanceImage = process.env.POCKETCODER_DOCKER_CONFORMANCE_IMAGE ?? "postgres:16-alpine";
const dockerConformanceAvailable =
  Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 &&
  Bun.spawnSync(["docker", "image", "inspect", conformanceImage], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

describe.skipIf(!dockerConformanceAvailable)("Docker writable-memory conformance", () => {
  test("mounts a private tmpfs writable by the non-root workspace identity", async () => {
    const processHandle = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--user",
        "10001:10001",
        "--tmpfs",
        "/home/onefin:rw,noexec,nosuid,size=256m,uid=10001,gid=10001,mode=0700",
        "--entrypoint",
        "sh",
        conformanceImage,
        "-eu",
        "-c",
        'probe=/home/onefin/.pocketcoder-probe; printf ok > "$probe"; test "$(cat "$probe")" = ok; rm "$probe"; stat -c "%a %u %g" /home/onefin',
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("700 10001 10001");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { dockerProjectionAvailable, dockerProjectionFixture } from "./docker-inputs-fixture.test";

describe.skipIf(!dockerProjectionAvailable)("Docker input projection failures", () => {
  test("image target aliases fail creation and clean the prepared incarnation", async () => {
    const f = await dockerProjectionFixture();
    try {
      const work = join(f.directory, "writable");
      await mkdir(work);
      f.launch.mounts = [
        { name: "alias", target: "/var/run/pocketcoder/inputs", source: { kind: "host-path", path: work } },
      ];
      await expect(f.driver.create(f.launch)).rejects.toThrow("aliases");
      expect(await readdir(join(f.publisher.root, f.scope.workspaceId))).toEqual([]);
      expect((await f.driver.list()).find((item) => item.workspaceId === f.scope.workspaceId)).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 30_000);

  test("an unavailable daemon rejects the daemon-host projection before runtime creation", async () => {
    const f = await dockerProjectionFixture();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: `unix://${join(f.directory, "unavailable.sock")}` };
      delete env.DOCKER_CONTEXT;
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { DockerDriver } from ${JSON.stringify(new URL("./docker.ts", import.meta.url).href)};
        import { FilesystemInputStorage } from ${JSON.stringify(new URL("../filesystem/filesystem-inputs.ts", import.meta.url).href)};
        const { launch, options, canonical } = JSON.parse(process.argv[1]);
        options.inputProjection.storage = new FilesystemInputStorage(canonical, [options.inputProjection.root]);
        try { await new DockerDriver(options).create(launch); process.exit(2); }
        catch (error) { console.log(String(error)); }
      `,
          JSON.stringify({
            launch: f.launch,
            options: { ...f.options, inputProjection: { ...f.options.inputProjection, storage: undefined } },
            canonical: f.canonical,
          }),
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      expect(output).toContain("docker run failed");
      expect(await readdir(join(f.publisher.root, f.scope.workspaceId))).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
});

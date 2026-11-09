// Builds the Pi starter from a copy outside the repository and runs real Pi turns in the container.
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PI_FIXTURE_CONTENT, startFakePiGateway } from "./fake-gateway";

// Digest-pinned like the published workspace image it stands in for.
const BASE = "oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d";
const enabled = process.env.POCKETCODER_PI_STARTER_CONFORMANCE === "1";
const REPOSITORY = resolve(import.meta.dir, "../../..");

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`docker ${args[0]}: ${err.slice(-2000)}`);
  return out.trim();
}

// Stand-in for the published workspace image: the supervisor at its fixed path.
async function baseImage(root: string) {
  const build = await Bun.build({
    // Built like the workspace image does, from the repository root.
    entrypoints: [join(REPOSITORY, "packages/supervisor/src/index.ts")],
    outdir: root,
    target: "bun",
  });
  if (!build.success) throw new Error("Supervisor build failed");
  await writeFile(
    join(root, "Dockerfile"),
    `FROM ${BASE}\nCOPY index.js /opt/pocketcoder/supervisor.js\nRUN printf '#!/bin/sh\\nexec bun /opt/pocketcoder/supervisor.js "$@"\\n' > /usr/local/bin/pocketcoder-supervisor && chmod 0555 /usr/local/bin/pocketcoder-supervisor\n`,
  );
  const tag = `pocketcoder-pi-base:${randomUUID()}`;
  await docker("build", "-q", "-t", tag, root);
  return `${tag}@${await docker("image", "inspect", "--format", "{{.Id}}", tag)}`;
}

test.skipIf(!enabled)(
  "the starter builds outside the repository and runs Pi turns over the execution protocol",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-starter-"));
    const gateway = startFakePiGateway("container-bearer");
    const tag = `pocketcoder-pi-starter:${randomUUID()}`;
    let container = "";
    try {
      const base = await baseImage(join(root, "base"));
      const starter = join(root, "starter");
      await cp(resolve(import.meta.dir, "starter"), starter, {
        recursive: true,
        filter: (path) => !path.includes("node_modules"),
      });
      await docker("build", "-q", "--build-arg", `POCKETCODER_WORKSPACE_IMAGE=${base}`, "-t", tag, starter);
      // The manifest pins the bytes actually installed in the image.
      const installed = await docker(
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        tag,
        "-c",
        "cat /opt/pocketcoder/workload.json; sha256sum /opt/pocketcoder/supervisor.js /opt/pocketcoder/pi-adapter.js",
      );
      const manifest = JSON.parse(installed.slice(0, installed.lastIndexOf("}") + 1));
      expect(installed).toContain(manifest.runtime.digest.slice(7));
      expect(installed).toContain(manifest.adapters.main.digest.slice(7));
      await writeFile(join(root, "bearer"), "container-bearer\n");
      container = await docker(
        "run",
        "-d",
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        `${join(root, "bearer")}:/run/pocketcoder/secrets/leases/model-gateway:ro`,
        "-e",
        "PI_ADAPTER_PORT=3284",
        "-e",
        "PI_PUBLICATION_MAX_BYTES=4194304",
        "-e",
        `PI_GATEWAY_URL=http://host.docker.internal:${gateway.port}/v1`,
        "-e",
        "PI_GATEWAY_MODEL=pocketcoder-test",
        "-e",
        "PI_GATEWAY_BEARER_FILE=/run/pocketcoder/secrets/leases/model-gateway",
        "--tmpfs",
        "/workspace:uid=10001,gid=10001",
        "--tmpfs",
        "/home/agent:uid=10001,gid=10001",
        "--entrypoint",
        "bun",
        tag,
        "/opt/pocketcoder/pi-adapter.js",
      );
      const call = async (action: string, body: unknown) =>
        JSON.parse(
          await docker(
            "exec",
            container,
            "bun",
            "-e",
            `const r=await fetch("http://127.0.0.1:3284/executions/${action}",{method:"POST",body:${JSON.stringify(JSON.stringify(body))}});console.log(await r.text())`,
          ),
        );
      const run = async (message: string) => {
        const execution = {
          workspaceId: randomUUID(),
          incarnationId: "container",
          owner: "conversation-request",
          requestId: randomUUID(),
        };
        const fingerprint = `sha256:${createHash("sha256").update(execution.requestId).digest("hex")}`;
        for (let attempt = 0; attempt < 50; attempt++) {
          const accepted = await call("accept", {
            acceptance: { execution, fingerprint, input: { message } },
            conversationIdentity: { conversation_id: randomUUID() },
          }).catch(() => null);
          if (accepted) break;
          await Bun.sleep(200);
        }
        for (let attempt = 0; attempt < 300; attempt++) {
          const fact = await call("lookup", { execution });
          if (fact.phase === "terminal") return fact;
          await Bun.sleep(200);
        }
        throw new Error("Turn did not finish");
      };
      expect((await run("Read the fixture file.")).outcome).toMatchObject({
        status: "completed",
        finalResponse: PI_FIXTURE_CONTENT,
      });
      const written = await run("Write notes.md containing: from the container");
      expect(written.publication.objects.map((object: { name: string }) => object.name)).toEqual(["notes.md"]);
    } finally {
      if (container) await docker("rm", "-f", container).catch(() => {});
      await docker("image", "rm", "-f", tag).catch(() => {});
      gateway.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  600_000,
);

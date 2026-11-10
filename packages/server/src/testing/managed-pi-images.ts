import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dockerCommand, serviceProbeImage } from "./service-image-fixture";

const REPOSITORY = resolve(import.meta.dir, "../../../..");

// Builds the PC-135 Pi starter the way a consumer does: on a digest-pinned workspace image that
// carries the supervisor, from a copy of the starter outside the repository tree.
export async function buildPiStarterImages(root: string) {
  const base = join(root, "base");
  await mkdir(base, { recursive: true });
  const build = await Bun.build({
    entrypoints: [join(REPOSITORY, "packages/supervisor/src/index.ts")],
    outdir: base,
    target: "bun",
  });
  if (!build.success) throw new Error("Supervisor build failed");
  await Bun.write(
    join(base, "Dockerfile"),
    `FROM ${serviceProbeImage}\nCOPY index.js /opt/pocketcoder/supervisor.js\nRUN printf '#!/bin/sh\\nexec bun /opt/pocketcoder/supervisor.js "$@"\\n' > /usr/local/bin/pocketcoder-supervisor && chmod 0555 /usr/local/bin/pocketcoder-supervisor\n`,
  );
  const baseTag = `pocketcoder-pi-base:${randomUUID()}`;
  await dockerCommand("build", "-q", "-t", baseTag, base);
  const baseImage = `${baseTag}@${await dockerCommand("image", "inspect", "--format", "{{.Id}}", baseTag)}`;
  const starter = join(root, "starter");
  await cp(join(REPOSITORY, "examples/harnesses/pi/starter"), starter, {
    recursive: true,
    filter: (path) => !path.includes("node_modules"),
  });
  const tag = `pocketcoder-pi-starter:${randomUUID()}`;
  await dockerCommand("build", "-q", "--build-arg", `POCKETCODER_WORKSPACE_IMAGE=${baseImage}`, "-t", tag, starter);
  const id = await dockerCommand("image", "inspect", "--format", "{{.Id}}", tag);
  // The manifest the driver verifies records the installed runtime and adapter digests.
  const workload = JSON.parse(
    await dockerCommand("run", "--rm", "--entrypoint", "cat", tag, "/opt/pocketcoder/workload.json"),
  ) as { runtime: { digest: string }; adapters: { main: { digest: string } } };
  const pi = await dockerCommand(
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    tag,
    "/opt/pi/node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  return {
    image: `${tag}@${id}`,
    imageId: id,
    runtimeDigest: workload.runtime.digest,
    adapterDigest: workload.adapters.main.digest,
    piVersion: (JSON.parse(pi) as { version: string }).version,
    async remove() {
      await dockerCommand("image", "rm", "-f", tag).catch(() => {});
      await dockerCommand("image", "rm", "-f", baseTag).catch(() => {});
    },
  };
}

// The published Pi example template, pointed at the built image and at the gateway fixture as the
// only allowed egress destination. Its fixed-scope slot names the controller's issuer secret.
export async function piManagedTemplate(
  images: Awaited<ReturnType<typeof buildPiStarterImages>>,
  gatewayPort: number,
  issuerSecret: string,
) {
  const raw = await Bun.file(join(REPOSITORY, "examples/templates/pi-managed.json")).json();
  raw.metadata.name = `pi-managed-${randomUUID().slice(0, 8)}`;
  raw.spec.image = images.image;
  raw.spec.runtime.digest = images.runtimeDigest;
  raw.spec.adapters.main.digest = images.adapterDigest;
  const env = raw.spec.services.agent.process.env;
  env.PI_GATEWAY_URL = `http://host.docker.internal:${gatewayPort}/v1`;
  env.PI_GATEWAY_MODEL = "pocketcoder-test";
  raw.spec.credentialSlots["model-gateway"].policyRef = issuerSecret;
  raw.spec.network = {
    mode: "restricted",
    allow: [{ domain: "host.docker.internal", ports: [gatewayPort], allowPrivate: true }],
  };
  return raw;
}

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredWarmProvider, ProviderRef, WarmRuntimeLaunch } from "@pstdio/pocketcoder-runtime-core";
import { egressConfig, poolInput } from "../egress/egress";
import type { ResolvedDockerOptions } from "./docker";
import { DIGEST_LABEL, POOL_RUNTIME_LABEL } from "./docker";
import { appendSecurityOptions } from "./docker-args";
import { resolveDockerImage, runDocker } from "./docker-command";
import { createDockerEgress } from "./docker-egress";
export async function createWarmDocker(opts: ResolvedDockerOptions, launch: WarmRuntimeLaunch): Promise<ProviderRef> {
  const spec = launch.template.spec;
  if (spec.imagePullSecret) throw new Error("Private images cannot use warm pools");
  await mkdir(opts.inputDir, { recursive: true, mode: 0o700 });
  await chmod(opts.inputDir, 0o700);
  const inputFile = join(opts.inputDir, `pool-${launch.runtimeId}.json`);
  const restricted = spec.network.mode === "restricted";
  const egressName = `pocketcoder-egress-pool-${launch.runtimeId}`;
  const egressFile = join(opts.inputDir, `pool-${launch.runtimeId}-egress.json`);
  let egressId: string | null = null;
  if (restricted) {
    await writeFile(egressFile, JSON.stringify(egressConfig(opts, launch.input, spec.network, launch.expiresAt)), {
      mode: 0o600,
    });
    egressId = await createDockerEgress(
      opts,
      egressName,
      `pocketcoder.egress-pool=${launch.runtimeId}`,
      DIGEST_LABEL,
      launch.template.digest,
      egressFile,
    );
  }
  await writeFile(inputFile, JSON.stringify(restricted ? poolInput(launch.input) : launch.input), {
    mode: 0o644,
  });
  const name = `pocketcoder-pool-${launch.runtimeId}`;
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `${POOL_RUNTIME_LABEL}=${launch.runtimeId}`,
    "--label",
    `${DIGEST_LABEL}=${launch.template.digest}`,
    "--restart=no",
    "--user",
    `${spec.security.uid}:${spec.security.gid}`,
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    spec.resources.cpu.endsWith("m") ? String(Number(spec.resources.cpu.slice(0, -1)) / 1000) : spec.resources.cpu,
    "--memory",
    spec.resources.memory.replace("Mi", "m").replace("Gi", "g"),
    "-v",
    `${inputFile}:/run/pocketcoder/input:ro`,
  ];
  appendSecurityOptions(args, spec);
  if (egressId) args.push("--network", `container:${egressId}`);
  else if (opts.network) args.push("--network", opts.network);
  if (!egressId && opts.addHostGateway) args.push("--add-host", "host.docker.internal:host-gateway");
  for (const [key, value] of Object.entries(spec.env)) args.push("-e", `${key}=${value}`);
  args.push(await resolveDockerImage(opts.dockerBin, spec.image), ...spec.command);
  try {
    const id = await runDocker(opts.dockerBin, args);
    return {
      kind: "docker",
      id,
      name,
      poolRuntimeId: launch.runtimeId,
      ...(egressId ? { egressId, egressName } : {}),
    };
  } catch (error) {
    await rm(inputFile, { force: true });
    await rm(egressFile, { force: true });
    if (egressId) await runDocker(opts.dockerBin, ["rm", "-f", egressId]).catch(() => {});
    throw error;
  }
}

export async function listWarmDocker(bin: string): Promise<DiscoveredWarmProvider[]> {
  const out = await runDocker(bin, [
    "ps",
    "--all",
    "--filter",
    `label=${POOL_RUNTIME_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Label "${POOL_RUNTIME_LABEL}"}}\t{{.Label "${DIGEST_LABEL}"}}`,
  ]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [id = "", runtimeId = "", templateDigest = ""] = line.split("\t");
    return {
      runtimeId,
      templateDigest,
      ref: {
        kind: "docker",
        id,
        name: `pocketcoder-pool-${runtimeId}`,
        poolRuntimeId: runtimeId,
        egressId: `pocketcoder-egress-pool-${runtimeId}`,
        egressName: `pocketcoder-egress-pool-${runtimeId}`,
      },
    };
  });
}

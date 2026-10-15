import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { directory, overlaps } from "../filesystem/projection-paths";
import { runDocker } from "./docker-command";

export interface PrivateInputBacking {
  device: string | undefined;
  root: string;
}

function readMountTable(table: string) {
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  const mounted = table.split("\n").map((line) => {
    const fields = line.split(" ");
    return {
      device: fields[2],
      root: decode(fields[3] ?? ""),
      path: decode(fields[4] ?? ""),
      readOnly: fields[5]?.split(",").includes("ro"),
    };
  });
  return mounted;
}

export function assertInputMountTable(table: string, target: string, privateBackings: PrivateInputBacking[]) {
  const mounted = readMountTable(table);
  // The rootfs is an ancestor; no additional mount may cover this root or a descendant.
  const relevant = mounted.filter((mount) => mount.path !== "/" && overlaps(mount.path, target));
  if (relevant.length !== 1 || relevant[0]?.path !== target || !relevant[0].readOnly)
    throw new Error("Docker input projection has nested mounts or target aliases.");
  const input = relevant[0];
  if (mounted.some((mount) => mount !== input && mount.device === input.device && overlaps(mount.root, input.root)))
    throw new Error("Docker input projection has a backing mount alias.");
  for (const backing of privateBackings)
    if (mounted.some((mount) => mount.device === backing.device && overlaps(mount.root, backing.root)))
      throw new Error("Docker workload exposes a private input backing alias.");
}

export async function probeDaemonHost(bin: string, image: string, path: string, privateRoots: string[]) {
  const token = randomUUID();
  const name = `.probe-${randomUUID()}`;
  const roots = [path, ...privateRoots];
  const targets = roots.map((_, index) => `/storage-${index}`);
  const markers: string[] = [];
  try {
    for (const root of roots) {
      await directory(root);
      const marker = join(root, name);
      await writeFile(marker, token, { mode: 0o444, flag: "wx" });
      markers.push(marker);
    }
    const mounts = roots.flatMap((root, index) => [
      "--mount",
      `type=bind,src=${root},dst=${targets[index]},readonly,bind-propagation=rprivate`,
    ]);
    const commands = targets.map((target) => `cat ${target}/${name}; printf '\n'`);
    const result = await runDocker(bin, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_READ_SEARCH",
      "--user",
      "0:0",
      "--security-opt",
      "no-new-privileges",
      ...mounts,
      "--entrypoint",
      "/bin/sh",
      image,
      "-eu",
      "-c",
      [...commands, "cat /proc/self/mountinfo"].join("; "),
    ]);
    const lines = result.split("\n");
    if (lines.slice(0, roots.length).some((line) => line !== token))
      throw new Error("Docker daemon-host input storage is unavailable.");
    const table = readMountTable(lines.slice(roots.length).join("\n"));
    return targets
      .map((target) => {
        const mounted = table.filter((mount) => overlaps(mount.path, target) && mount.path !== "/");
        const root = mounted[0];
        if (mounted.length !== 1 || root?.path !== target || !root.readOnly)
          throw new Error("Nested daemon-host input storage is unsupported.");
        return { device: root.device, root: root.root };
      })
      .slice(1);
  } finally {
    for (const marker of markers) await rm(marker, { force: true });
  }
}

// Read through the live process root. Docker cp can re-resolve a replaced host path.
export async function verifyContainerInputBoundary(
  bin: string,
  image: string,
  id: string,
  source: string,
  target: string,
  privateBackings: PrivateInputBacking[],
) {
  const name = `.check-${randomUUID()}`;
  const token = randomUUID();
  const marker = join(source, name);
  try {
    await writeFile(marker, token, { mode: 0o444, flag: "wx" });
    const result = await runDocker(bin, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SYS_PTRACE",
      "--security-opt",
      "no-new-privileges",
      "--pid",
      `container:${id}`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-eu",
      "-c",
      `if ! cat /proc/1/root${target}/${name}; then printf unavailable; fi; printf '\n'; cat /proc/1/mountinfo`,
    ]);
    const [observed, ...table] = result.split("\n");
    assertInputMountTable(table.join("\n"), target, privateBackings);
    if (observed !== token) throw new Error("Docker input mount is unavailable.");
  } finally {
    await rm(marker, { force: true });
  }
}

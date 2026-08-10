import { runDocker } from "./docker-command";

interface DockerEgressOptions {
  network: string;
  addHostGateway: boolean;
  dockerBin: string;
  egressImage?: string;
}

export async function createDockerEgress(
  opts: DockerEgressOptions,
  name: string,
  label: string,
  digestLabel: string,
  digest: string,
  configFile: string,
): Promise<string> {
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    label,
    "--label",
    `${digestLabel}=${digest}`,
    "--restart=no",
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "-v",
    `${configFile}:/run/pocketcoder/egress.json:ro`,
  ];
  if (opts.network) args.push("--network", opts.network);
  if (opts.addHostGateway) args.push("--add-host", "host.docker.internal:host-gateway");
  args.push(opts.egressImage as string);
  const id = await runDocker(opts.dockerBin, args);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await runDocker(opts.dockerBin, ["exec", id, "/usr/local/bin/pocketcoder-egress", "health"]);
      return id;
    } catch {
      await Bun.sleep(100);
    }
  }
  await runDocker(opts.dockerBin, ["rm", "-f", id]).catch(() => {});
  throw new Error("egress companion did not become ready");
}

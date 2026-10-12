import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import type { createKubernetesCluster } from "./kubernetes-cluster";

const CONFIG = "/private/purge-config.json";
const DIRECTORY = "/private/purge-authority";

// Configuration goes through stdin so finite fixture credentials never enter command logs.
const INITIALIZE = `
import { mkdirSync, chownSync, chmodSync, writeFileSync } from "node:fs";
mkdirSync("${DIRECTORY}", { recursive: true, mode: 0o700 });
chownSync("${DIRECTORY}", 10001, 10001);
chmodSync("${DIRECTORY}", 0o700);
writeFileSync("${CONFIG}", await Bun.stdin.text(), { mode: 0o600 });
chownSync("${CONFIG}", 10001, 10001);
chmodSync("${CONFIG}", 0o600);
`;

export async function managerImageAuthority(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  image: string,
  volume: string[],
) {
  const fixture = await objectStorageFixture();
  try {
    await cluster.run(["docker", "network", "connect", "kind", fixture.config.bucket]);
    const address = await cluster.run([
      "docker",
      "inspect",
      "--format",
      '{{(index .NetworkSettings.Networks "kind").IPAddress}}',
      fixture.config.bucket,
    ]);
    if (!address) throw new Error("Owned object storage fixture address is missing.");
    const config = {
      directory: DIRECTORY,
      storage: { ...fixture.config, endpoint: `http://${address}:9000` },
    };
    const initialize = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-i",
        "--user",
        "0:0",
        ...volume,
        "--entrypoint",
        "/usr/local/bin/bun",
        image,
        "-e",
        INITIALIZE,
      ],
      { stdin: new Blob([JSON.stringify(config)]), stdout: "ignore", stderr: "ignore" },
    );
    const code = await initialize.exited;
    if (code !== 0) throw new Error(`Private manager image configuration failed (${code}).`);
    return { path: CONFIG, close: fixture.close };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

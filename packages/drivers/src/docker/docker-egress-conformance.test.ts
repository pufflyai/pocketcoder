// Proves private host-owned config admission and complete capability loss after the real egress UID drop.
import { expect, test } from "bun:test";
import { createDockerEgress } from "./docker-egress";

const image = process.env.POCKETCODER_EGRESS_CONFORMANCE_IMAGE;
const conformanceTest = image ? test : test.skip;

async function docker(args: string[], allowFailure = false) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0 && !allowFailure) throw new Error("Owned Docker conformance command failed");
    return { stdout: stdout.trim(), stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

function processIdentity(source: string) {
  const fields = ["Uid", "Gid", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"];
  return Object.fromEntries(
    source.split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator);
      return fields.includes(key) ? [[key, line.slice(separator + 1).trim()]] : [];
    }),
  );
}

async function prepare(volume: string, token: string) {
  await docker(["volume", "create", volume]);
  const config = JSON.stringify({
    policy: { mode: "restricted", allow: [] },
    control_url: "http://127.0.0.1:18082",
    audit_url: "http://127.0.0.1:18082/events",
    audit_token: token,
  });
  await docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "-v",
    `${volume}:/proof`,
    "-e",
    `FIXTURE_CONFIG=${config}`,
    "--entrypoint",
    "sh",
    image as string,
    "-eu",
    "-c",
    'printf "%s" "$FIXTURE_CONFIG" > /proof/egress.json; chmod 600 /proof/egress.json; chown 1001:1001 /proof/egress.json',
  ]);
  const mount = await docker(["volume", "inspect", volume, "--format", "{{.Mountpoint}}"]);
  return `${mount.stdout}/egress.json`;
}

conformanceTest(
  "non-root host config stays private and the healthy egress process loses all usable capabilities",
  async () => {
    const owner = crypto.randomUUID();
    const volume = `pc-egress-config-${owner}`;
    const name = `pc-egress-private-${owner}`;
    const token = crypto.randomUUID();
    try {
      const path = await prepare(volume, token);
      const id = await createDockerEgress(
        { network: "", addHostGateway: false, dockerBin: "docker", egressImage: image },
        name,
        `pocketcoder.egress-workspace=${owner}`,
        "pocketcoder.template-digest",
        "conformance",
        path,
      );
      const inspect = JSON.parse((await docker(["inspect", id])).stdout)[0];
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      const binds = inspect.Mounts.filter((mount: { Type: string }) => mount.Type === "bind");
      expect(binds.length).toBe(1);
      expect(binds[0].Destination).toBe("/run/pocketcoder/egress.json");
      expect(binds[0].RW).toBe(false);
      const rootWrite = await docker(["exec", id, "sh", "-c", "printf denied > /run/pocketcoder/egress.json"], true);
      expect(rootWrite.exitCode).not.toBe(0);
      const status = await docker([
        "exec",
        id,
        "sh",
        "-c",
        "for status in /proc/1/task/*/status; do cat \"$status\"; printf '\\nBOUNDARY\\n'; done",
      ]);
      const identities = status.stdout
        .split("\nBOUNDARY\n")
        .filter((item) => item.trim())
        .map(processIdentity);
      expect(identities.length).toBeGreaterThan(0);
      for (const identity of identities) {
        expect(identity.Uid?.split(/\s+/)).toEqual(["999", "999", "999", "999"]);
        expect(identity.Gid?.split(/\s+/)).toEqual(["999", "999", "999", "999"]);
        for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) expect(BigInt(`0x${identity[key]}`)).toBe(0n);
        expect(identity.NoNewPrivs).toBe("1");
        // Do not enable privileged file-handle lookup during initialization.
        expect(BigInt(`0x${identity.CapBnd}`) & (1n << 2n)).toBe(0n);
      }
      const metadata = await docker(["exec", id, "stat", "-c", "%a %u %g", "/run/pocketcoder/egress.json"]);
      expect(metadata.stdout).toBe("600 1001 1001");
      const read = await docker(["exec", "--user", "999:999", id, "cat", "/run/pocketcoder/egress.json"], true);
      expect(read.exitCode).not.toBe(0);
      expect(read.stdout).toBe("");
      expect(read.stderr.includes(token)).toBe(false);
      const write = await docker(
        ["exec", "--user", "999:999", id, "sh", "-c", "printf denied > /run/pocketcoder/egress.json"],
        true,
      );
      expect(write.exitCode).not.toBe(0);
      expect((await docker(["exec", id, "/usr/local/bin/pocketcoder-egress", "health"])).exitCode).toBe(0);
      const logs = await docker(["logs", id]);
      expect((logs.stdout + logs.stderr).includes(token)).toBe(false);
    } finally {
      await docker(["rm", "-f", name], true);
      await docker(["volume", "rm", volume], true);
    }
  },
  60000,
);

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

interface CommandResult {
  stdout: string;
  stderr: string;
}

function namespace() {
  return process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
}

function conformanceImage() {
  const image = process.env.POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE;
  if (!image || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE must be pinned by digest");
  }
  return image;
}

async function kubectl(args: string[], input?: string): Promise<CommandResult> {
  const child = Bun.spawn(["kubectl", ...args], {
    ...(input ? { stdin: "pipe" } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `kubectl exited ${exitCode}`);
  return { stdout, stderr };
}

async function apply(manifest: unknown) {
  return kubectl(["-n", namespace(), "apply", "-f", "-"], JSON.stringify(manifest));
}

async function waitFor(kind: "job" | "pod", name: string, timeout = "120s") {
  const condition = kind === "job" ? "condition=complete" : "jsonpath={.status.phase}=Succeeded";
  return kubectl([
    "-n",
    namespace(),
    "wait",
    `${kind}/${name}`,
    `--for=${condition}`,
    `--timeout=${timeout}`,
  ]);
}

async function logs(kind: "job" | "pod", name: string) {
  return kubectl(["-n", namespace(), "logs", `${kind}/${name}`]);
}

function deleteResource(kind: "job" | "pod", name: string) {
  Bun.spawnSync([
    "kubectl",
    "-n",
    namespace(),
    "delete",
    kind,
    name,
    "--ignore-not-found",
    "--wait=false",
  ]);
}

async function deleteAndWait(kind: "job" | "pod", name: string) {
  await kubectl([
    "-n",
    namespace(),
    "delete",
    kind,
    name,
    "--ignore-not-found",
    "--wait=true",
    "--timeout=30s",
  ]);
}

function podSecurity(uid = 10_001, gid = 10_001) {
  return {
    runAsUser: uid,
    runAsGroup: gid,
    runAsNonRoot: true,
    fsGroup: gid,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  };
}

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
  "Kubernetes writable-memory conformance",
  () => {
    test("makes a memory-backed emptyDir writable through fsGroup", async () => {
      const name = `pocketcoder-memory-${randomUUID().slice(0, 8)}`;
      const manifest = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace: namespace() },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: podSecurity(),
          containers: [
            {
              name: "probe",
              image: conformanceImage(),
              command: [
                "sh",
                "-eu",
                "-c",
                'probe=/home/onefin/.pocketcoder-probe; printf ok > "$probe"; test "$(cat "$probe")" = ok; rm "$probe"; stat -c "%a %u %g" /home/onefin',
              ],
              volumeMounts: [{ name: "memory", mountPath: "/home/onefin" }],
            },
          ],
          volumes: [{ name: "memory", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } }],
        },
      };
      await apply(manifest);
      try {
        await waitFor("pod", name, "90s");
        const result = await logs("pod", name);
        expect(result.stdout.trim()).toMatch(/^\d{3,4} \d+ 10001$/);
      } finally {
        deleteResource("pod", name);
      }
    }, 120_000);
  },
);

const nfsEnabled =
  process.env.POCKETCODER_KUBERNETES_CONFORMANCE === "1" &&
  Boolean(process.env.POCKETCODER_KUBERNETES_WORKSPACE_CLAIM);

function safeSubPath() {
  const value = process.env.POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH ?? "workspaces";
  if (
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[a-zA-Z0-9._/-]+$/.test(value)
  ) {
    throw new Error("POCKETCODER_KUBERNETES_WORKSPACE_SUBPATH must be a safe relative path");
  }
  return value;
}

function nfsVolume(claimName: string) {
  return { name: "storage", persistentVolumeClaim: { claimName } };
}

function nfsSetupJob(
  name: string,
  claimName: string,
  own: string,
  sibling: string,
  checkpoint: string,
) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: namespace() },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: podSecurity(),
          containers: [
            {
              name: "setup",
              image: conformanceImage(),
              command: [
                "sh",
                "-euc",
                'root="/storage/$WORKSPACE_PREFIX"; own="$root/$OWN"; sibling="$root/$SIBLING"; checkpoint="/storage/checkpoints/$CHECKPOINT"; mkdir -p "$own/worktree" "$sibling/worktree" "$checkpoint"; chmod 0711 "$root" "$own" "$sibling"; chmod 0777 "$own/worktree"; chmod 0700 "$sibling/worktree" "$checkpoint"; printf own > "$own/worktree/created-by-server"; printf sibling > "$sibling/worktree/private"; printf checkpoint > "$checkpoint/probe"; test "$(cat "$checkpoint/probe")" = checkpoint; stat -c "%a %u %g %n" "$root" "$own" "$own/worktree" "$checkpoint"',
              ],
              env: [
                { name: "WORKSPACE_PREFIX", value: safeSubPath() },
                { name: "OWN", value: own },
                { name: "SIBLING", value: sibling },
                { name: "CHECKPOINT", value: checkpoint },
              ],
              volumeMounts: [{ name: "storage", mountPath: "/storage" }],
            },
          ],
          volumes: [nfsVolume(claimName)],
        },
      },
    },
  };
}

function nfsProbePod(name: string, claimName: string, own: string, sibling: string) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: namespace() },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "pocketcoder-workspace",
      automountServiceAccountToken: false,
      securityContext: podSecurity(),
      containers: [
        {
          name: "probe",
          image: conformanceImage(),
          command: [
            "sh",
            "-euc",
            'test "$(cat /workspace/created-by-server)" = own; printf workspace > /workspace/created-by-workspace; test "$(cat /workspace/created-by-workspace)" = workspace; test ! -e "/workspace/../$SIBLING/worktree/private"; ln -s "../../$SIBLING/worktree/private" /workspace/sibling-link; if cat /workspace/sibling-link 2>/dev/null; then echo sibling-readable >&2; exit 1; fi; test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token; stat -c "%a %u %g" /workspace',
          ],
          env: [{ name: "SIBLING", value: sibling }],
          volumeMounts: [
            {
              name: "storage",
              mountPath: "/workspace",
              subPath: `${safeSubPath()}/${own}/worktree`,
            },
          ],
        },
      ],
      volumes: [nfsVolume(claimName)],
    },
  };
}

function nfsCleanupPod(
  name: string,
  claimName: string,
  own: string,
  sibling: string,
  checkpoint: string,
) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: namespace() },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: podSecurity(),
      containers: [
        {
          name: "cleanup",
          image: conformanceImage(),
          command: [
            "sh",
            "-euc",
            'rm -rf -- "/storage/$WORKSPACE_PREFIX/$OWN" "/storage/$WORKSPACE_PREFIX/$SIBLING" "/storage/checkpoints/$CHECKPOINT"',
          ],
          env: [
            { name: "WORKSPACE_PREFIX", value: safeSubPath() },
            { name: "OWN", value: own },
            { name: "SIBLING", value: sibling },
            { name: "CHECKPOINT", value: checkpoint },
          ],
          volumeMounts: [{ name: "storage", mountPath: "/storage" }],
        },
      ],
      volumes: [nfsVolume(claimName)],
    },
  };
}

async function clusterEvidence(setupLogs: string, probeLogs: string) {
  const region = process.env.POCKETCODER_DIGITALOCEAN_REGION;
  const nfsTier = process.env.POCKETCODER_DIGITALOCEAN_NFS_TIER;
  if (!region || !nfsTier) {
    throw new Error(
      "POCKETCODER_DIGITALOCEAN_REGION and POCKETCODER_DIGITALOCEAN_NFS_TIER are required",
    );
  }
  const version = JSON.parse((await kubectl(["version", "-o", "json"])).stdout) as {
    serverVersion?: { gitVersion?: string };
  };
  return {
    doks_version: version.serverVersion?.gitVersion ?? "unknown",
    region,
    nfs_tier: nfsTier,
    namespace: namespace(),
    claim: process.env.POCKETCODER_KUBERNETES_WORKSPACE_CLAIM,
    setup: setupLogs.trim(),
    probe: probeLogs.trim(),
  };
}

describe.skipIf(!nfsEnabled)("DigitalOcean NFS subPath conformance", () => {
  test("supports non-root writes and blocks sibling reads", async () => {
    const claimName = process.env.POCKETCODER_KUBERNETES_WORKSPACE_CLAIM as string;
    const suffix = randomUUID().slice(0, 8);
    const setupName = `pocketcoder-nfs-setup-${suffix}`;
    const probeName = `pocketcoder-nfs-probe-${suffix}`;
    const cleanupName = `pocketcoder-nfs-cleanup-${suffix}`;
    const own = randomUUID();
    const sibling = randomUUID();
    const checkpoint = randomUUID();
    let bodyError: unknown;
    let setupOutput = "";
    let probeOutput = "";
    try {
      await apply(nfsSetupJob(setupName, claimName, own, sibling, checkpoint));
      await waitFor("job", setupName);
      setupOutput = (await logs("job", setupName)).stdout;
      await apply(nfsProbePod(probeName, claimName, own, sibling));
      await waitFor("pod", probeName);
      probeOutput = (await logs("pod", probeName)).stdout;
      expect(probeOutput.trim()).toMatch(/^\d{3,4} \d+ \d+$/);
    } catch (error) {
      bodyError = error;
    }

    const cleanupErrors: unknown[] = [];
    for (const [kind, name] of [
      ["pod", probeName],
      ["job", setupName],
    ] as const) {
      try {
        await deleteAndWait(kind, name);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await apply(nfsCleanupPod(cleanupName, claimName, own, sibling, checkpoint));
      await waitFor("pod", cleanupName);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      deleteResource("pod", cleanupName);
      deleteResource("pod", probeName);
      deleteResource("job", setupName);
    }

    if (bodyError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors].filter((error) => error !== undefined),
        "DigitalOcean NFS conformance failed",
      );
    }
    console.log(JSON.stringify(await clusterEvidence(setupOutput, probeOutput), null, 2));
  }, 240_000);
});

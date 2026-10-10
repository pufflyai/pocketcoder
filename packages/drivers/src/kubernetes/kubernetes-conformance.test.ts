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
  return kubectl(["-n", namespace(), "wait", `${kind}/${name}`, `--for=${condition}`, `--timeout=${timeout}`]);
}

async function logs(kind: "job" | "pod", name: string) {
  return kubectl(["-n", namespace(), "logs", `${kind}/${name}`]);
}

function deleteResource(kind: "job" | "pod", name: string) {
  Bun.spawnSync(["kubectl", "-n", namespace(), "delete", kind, name, "--ignore-not-found", "--wait=false"]);
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

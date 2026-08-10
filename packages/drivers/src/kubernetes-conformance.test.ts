import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
  "Kubernetes writable-memory conformance",
  () => {
    test("makes a memory-backed emptyDir writable through fsGroup", async () => {
      const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
      const image = process.env.POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE ?? "busybox:1.36";
      const name = `pocketcoder-memory-${randomUUID().slice(0, 8)}`;
      const manifest = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace },
        spec: {
          restartPolicy: "Never",
          securityContext: {
            runAsUser: 10_001,
            runAsGroup: 10_001,
            runAsNonRoot: true,
            fsGroup: 10_001,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "probe",
              image,
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
      const apply = Bun.spawn(["kubectl", "-n", namespace, "apply", "-f", "-"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      apply.stdin.write(JSON.stringify(manifest));
      apply.stdin.end();
      const [applyError, applyCode] = await Promise.all([
        new Response(apply.stderr).text(),
        apply.exited,
      ]);
      expect(applyCode, applyError).toBe(0);
      try {
        const wait = Bun.spawn(
          [
            "kubectl",
            "-n",
            namespace,
            "wait",
            `pod/${name}`,
            "--for=jsonpath={.status.phase}=Succeeded",
            "--timeout=90s",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [waitError, waitCode] = await Promise.all([
          new Response(wait.stderr).text(),
          wait.exited,
        ]);
        expect(waitCode, waitError).toBe(0);
        const logs = Bun.spawnSync(["kubectl", "-n", namespace, "logs", name]);
        expect(logs.exitCode, logs.stderr.toString()).toBe(0);
        expect(logs.stdout.toString().trim()).toMatch(/^\d{3,4} \d+ 10001$/);
      } finally {
        Bun.spawnSync([
          "kubectl",
          "-n",
          namespace,
          "delete",
          "pod",
          name,
          "--ignore-not-found",
          "--wait=false",
        ]);
      }
    }, 120_000);
  },
);

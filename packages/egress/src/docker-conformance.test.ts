import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkEventInput } from "@pstdio/pocketcoder-contracts";

const image = process.env.POCKETCODER_EGRESS_CONFORMANCE_IMAGE;
const conformanceTest = image ? test : test.skip;

async function docker(args: string[], allowFailure = false) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(stderr.trim());
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("conformance condition did not become ready");
}

conformanceTest(
  "real Docker network namespace stays restricted when the proxy exits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pocketcoder-egress-conformance-"));
    const suffix = randomUUID().slice(0, 8);
    const egressName = `pc-egress-${suffix}`;
    const workspaceName = `pc-workspace-${suffix}`;
    const events: NetworkEventInput[] = [];
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
          const body = (await request.json()) as { events: NetworkEventInput[] };
          events.push(...body.events);
          return Response.json({ accepted: body.events.length });
        }
        return new Response(url.pathname === "/allowed" ? "allowed" : "not found", {
          status: url.pathname === "/allowed" ? 200 : 404,
        });
      },
    });
    const host = "host.docker.internal";
    const configPath = join(root, "egress.json");
    await writeFile(
      configPath,
      JSON.stringify({
        policy: {
          mode: "restricted",
          allow: [{ domain: host, ports: [server.port], allowPrivate: true }],
        },
        control_url: `http://${host}:${server.port}`,
        audit_url: `http://${host}:${server.port}/events`,
        audit_token: "conformance",
      }),
    );

    try {
      const gateway = await docker([
        "run",
        "--detach",
        "--name",
        egressName,
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
        "--add-host",
        "host.docker.internal:host-gateway",
        "--volume",
        `${configPath}:/run/pocketcoder/egress.json:ro`,
        image as string,
      ]);
      try {
        await waitFor(async () => {
          const result = await docker(
            ["exec", gateway.stdout, "/usr/local/bin/pocketcoder-egress", "health"],
            true,
          );
          return result.exitCode === 0;
        });
      } catch {
        const logs = await docker(["logs", gateway.stdout], true);
        throw new Error(`egress did not become ready: ${logs.stdout}${logs.stderr}`);
      }
      const identity = await docker([
        "exec",
        gateway.stdout,
        "sh",
        "-c",
        "grep -E '^(Uid|CapEff):' /proc/1/status",
      ]);
      expect(identity.stdout).toContain("Uid:\t999\t999\t999\t999");
      expect(identity.stdout).toContain("CapEff:\t0000000000000000");

      const allowed = await docker([
        "run",
        "--rm",
        "--network",
        `container:${gateway.stdout}`,
        "curlimages/curl:8.16.0",
        "--fail",
        "--proxy",
        "http://127.0.0.1:18080",
        `http://${host}:${server.port}/allowed?credential=redacted`,
      ]);
      expect(allowed.stdout).toBe("allowed");

      const denied = await docker([
        "run",
        "--rm",
        "--network",
        `container:${gateway.stdout}`,
        "curlimages/curl:8.16.0",
        "--silent",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--proxy",
        "http://127.0.0.1:18080",
        "http://denied.invalid/private?credential=redacted",
      ]);
      expect(denied.stdout).toBe("403");
      await waitFor(async () => events.length >= 2);
      expect(events.map(({ decision, host, path }) => ({ decision, host, path }))).toEqual([
        { decision: "allow", host, path: "/allowed" },
        { decision: "deny", host: "denied.invalid", path: null },
      ]);

      const direct = await docker(
        [
          "run",
          "--rm",
          "--network",
          `container:${gateway.stdout}`,
          "curlimages/curl:8.16.0",
          "--noproxy",
          "*",
          "--connect-timeout",
          "1",
          `http://${host}:${server.port}/allowed`,
        ],
        true,
      );
      expect(direct.exitCode).not.toBe(0);

      await docker([
        "run",
        "--detach",
        "--name",
        workspaceName,
        "--network",
        `container:${gateway.stdout}`,
        "alpine:3.22",
        "sleep",
        "30",
      ]);
      await docker(["kill", gateway.stdout]);
      const afterCrash = await docker(
        ["exec", workspaceName, "wget", "-T", "1", "-q", `http://${host}:${server.port}/allowed`],
        true,
      );
      expect(afterCrash.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
      await docker(["rm", "-f", workspaceName], true);
      await docker(["rm", "-f", egressName], true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

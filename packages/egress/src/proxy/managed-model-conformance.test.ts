// Proves on a real Docker network namespace that a managed budgeted workspace reaches the model
// gateway on its controller route only: the provider host, an alternate port on the controller,
// a redirect to the provider and direct IP traffic all fail.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedModelEgressRefusal, type NetworkPolicy } from "@pstdio/pocketcoder-contracts";

const image = process.env.POCKETCODER_EGRESS_CONFORMANCE_IMAGE;
const conformanceTest = image ? test : test.skip;
const host = "host.docker.internal";

async function docker(args: string[], allowFailure = false) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(stderr.trim());
  return { stdout: stdout.trim(), exitCode };
}

conformanceTest(
  "a managed workspace reaches the model gateway route and nothing that bypasses it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pocketcoder-model-egress-"));
    const name = `pc-model-egress-${randomUUID().slice(0, 8)}`;
    const provider = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("provider") });
    const controller = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/events") return Response.json({ accepted: 0 });
        if (path === "/v1/model-gateway/v1/responses") return new Response("gateway");
        return Response.redirect(`http://${host}:${provider.port}/v1/responses`, 302);
      },
    });
    // The controller is the only allowed destination; the configured provider host is not.
    const policy: NetworkPolicy = {
      mode: "restricted",
      allow: [{ domain: host, ports: [Number(controller.port)], allowPrivate: true }],
    };
    expect(managedModelEgressRefusal(policy, ["api.openai.com"])).toBeNull();
    const configPath = join(root, "egress.json");
    await writeFile(
      configPath,
      JSON.stringify({
        policy,
        control_url: `http://${host}:${controller.port}`,
        audit_url: `http://${host}:${controller.port}/events`,
        audit_token: "conformance",
      }),
    );
    const curl = (args: string[]) =>
      docker(
        [
          "run",
          "--rm",
          "--network",
          `container:${name}`,
          "curlimages/curl:8.16.0",
          "--silent",
          "--connect-timeout",
          "2",
          ...args,
        ],
        true,
      );
    try {
      await docker([
        "run",
        "--detach",
        "--name",
        name,
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
        `${host}:host-gateway`,
        "--volume",
        `${configPath}:/run/pocketcoder/egress.json:ro`,
        image as string,
      ]);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await docker(["exec", name, "/usr/local/bin/pocketcoder-egress", "health"], true)).exitCode === 0) break;
        await Bun.sleep(50);
      }
      const proxy = ["--proxy", "http://127.0.0.1:18080"];
      const gateway = await curl([...proxy, `http://${host}:${controller.port}/v1/model-gateway/v1/responses`]);
      expect(gateway.stdout).toBe("gateway");
      const direct = await curl([
        ...proxy,
        "--write-out",
        "%{http_code}",
        "--output",
        "/dev/null",
        "https://api.openai.com/v1/responses",
      ]);
      expect(direct.stdout).not.toBe("200");
      const alternatePort = await curl([
        ...proxy,
        "--write-out",
        "%{http_code}",
        "--output",
        "/dev/null",
        `http://${host}:${provider.port}/v1/responses`,
      ]);
      expect(alternatePort.stdout).toBe("403");
      const redirected = await curl([...proxy, "--location", `http://${host}:${controller.port}/elsewhere`]);
      expect(redirected.stdout).not.toBe("provider");
      const bypass = await curl(["--noproxy", "*", `http://${host}:${provider.port}/v1/responses`]);
      expect(bypass.exitCode).not.toBe(0);
    } finally {
      provider.stop(true);
      controller.stop(true);
      await docker(["rm", "-f", name], true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

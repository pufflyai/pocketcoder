import { expect, test } from "bun:test";
import { privateSourceLiveFixture } from "./private-source-live-fixture";

test.each(["docker", "kubernetes"] as const)(
  "%s clones real private Git source and revokes before the harness starts",
  async (provider) => {
    const f = await privateSourceLiveFixture(provider);
    try {
      expect(await f.git.probe("unauthorized")).toBe(401);
      const id = await f.create();
      const row = await f.ready(id);
      expect(row.resolvedSource?.resolved_commit).toBe(f.git.commit);
      expect(await f.git.probe(f.issuer.controls.captured)).toBe(401);
      expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
      expect(await f.store.listWorkspaceLeases(id)).toMatchObject([
        { state: "revoked", sourceUrl: f.git.url, sourceRevision: "main" },
      ]);
      const response = await fetch(`${f.baseUrl}/v1/workspaces/${id}/services/agent/source`, {
        headers: { authorization: `Bearer ${f.key.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ content: "private fixture content\n", credential_revoked: true });
      const logs = await f.store.readLogs(id, 0, 100);
      expect(JSON.stringify(logs)).not.toContain(f.issuer.authorization);
      if (provider === "docker") {
        const proc = Bun.spawn(["docker", "inspect", String(row.providerRef?.id)], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        const spec = JSON.parse(output)[0];
        expect(spec.HostConfig.Tmpfs["/worktree"]).toContain("size=4194304");
        expect(
          spec.Mounts.some(
            (mount: { Destination: string; Type: string }) =>
              mount.Destination === "/worktree" && mount.Type === "bind",
          ),
        ).toBe(false);
      }
      if (provider === "kubernetes") {
        const pods = JSON.parse(await f.kubectl(["get", "pods", "-o", "json"]));
        const spec = pods.items[0].spec;
        expect(spec.volumes).toContainEqual({ name: "persistent-0", emptyDir: { sizeLimit: "4194304" } });
        expect(spec.containers[0].resources.limits["ephemeral-storage"]).toBe("64Mi");
        expect(JSON.stringify(spec)).not.toContain(f.issuer.authorization);
        expect(JSON.stringify(spec)).not.toContain(f.issuer.controls.captured);
      }
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.each(["docker", "kubernetes"] as const)(
  "%s revokes source authority when setup fails",
  async (provider) => {
    const f = await privateSourceLiveFixture(provider);
    try {
      await f.client.templates.publish({
        ...f.manifest,
        spec: {
          ...f.manifest.spec,
          version: "1.0.1",
          setup: f.manifest.spec.setup.map((step) => ({ ...step, command: ["bun", "-e", "process.exit(42)"] })),
        },
      });
      const id = await f.create();
      const row = await f.failed(id);
      expect(row.reasonCode).toBe("child_exit_failure");
      expect(await f.store.listPendingWorkspaceLeases(id)).toEqual([]);
      expect(await f.store.listWorkspaceLeases(id)).toMatchObject([{ state: "revoked" }]);
      expect(await f.git.probe(f.issuer.controls.captured)).toBe(401);
    } finally {
      await f.close();
    }
  },
  60_000,
);

import { expect, test } from "bun:test";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { disposableSourceRuntime } from "./source-runtime";

test.each(["docker", "kubernetes"] as const)(
  "%s source storage is bounded and needs no host allocation",
  async (provider) => {
    const f = await leaseServiceFixture();
    try {
      const snapshot = f.workspace.templateSnapshot;
      const workspace = {
        ...f.workspace,
        templateSnapshot: {
          ...snapshot,
          spec: {
            ...snapshot.spec,
            persistence: {
              ...snapshot.spec.persistence,
              mounts: [{ name: "worktree", target: "/worktree", maxBytes: 1024, maxFiles: 4 }],
            },
          },
        },
      };
      const runtime = disposableSourceRuntime(provider);
      const source =
        provider === "docker"
          ? { kind: "tmpfs" as const, maxBytes: 1024, uid: snapshot.spec.security.uid, gid: snapshot.spec.security.gid }
          : { kind: "empty-dir" as const, maxBytes: 1024 };
      expect(await runtime.prepareStorage(workspace)).toEqual([{ name: "worktree", target: "/worktree", source }]);
      await expect(runtime.prepareStorage({ ...workspace, launchMode: "restore" })).rejects.toThrow(
        "new source workspace",
      );
      expect(await f.store.getWorkspaceStorage(workspace.id)).toBeNull();
    } finally {
      await f.close();
    }
  },
);

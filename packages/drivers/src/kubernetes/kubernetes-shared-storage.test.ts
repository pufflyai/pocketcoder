import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesSharedStorage } from "./kubernetes-shared-storage";

test("retains output after compute removal until trusted extraction is complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-shared-"));
  try {
    const storage = new KubernetesSharedStorage({
      root,
      checkpointRoot: join(root, "../", `${randomUUID()}-checkpoints`),
      claimName: "shared",
      storageClassName: "qualified-nfs",
      networkPolicyName: "storage-isolation",
      storageCidrs: ["192.0.2.1/32"],
      volumeName: "shared-pv",
      profile: "shared-writer-readonly/v1",
      maxBytes: 8 * 1024 ** 2,
      maxFiles: 16,
    });
    await storage.purgeInputs(randomUUID());
    const input = {
      retainForExtraction: true,
      storageId: randomUUID(),
      workspaceId: randomUUID(),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      mounts: [{ name: "output", target: "/outputs", maxBytes: 4 * 1024 ** 2, maxFiles: 16 }],
    };
    const interrupted = join(root, "pending", input.storageId);
    await mkdir(join(interrupted, "output"), { recursive: true });
    const allocation = await storage.allocate(input);
    const retried = await new KubernetesSharedStorage(storage.options).allocate(input);
    expect(retried.ref.uid).toBe(input.uid);
    expect(retried.ref.gid).toBe(input.gid);
    expect(retried.mounts).toEqual(allocation.mounts);
    await expect(storage.allocate({ ...input, storageId: randomUUID() })).rejects.toThrow("capacity");
    expect(allocation.mounts[0]?.source.kind).toBe("shared-filesystem");
    const output = join(root, "workspaces", input.storageId, "output", "result.txt");
    await writeFile(output, "retained");
    await expect(storage.deleteStorage(allocation.ref)).rejects.toThrow("extraction");
    const restarted = new KubernetesSharedStorage(storage.options);
    expect(await readFile(output, "utf8")).toBe("retained");
    expect(await restarted.listStorage()).toHaveLength(1);
    await restarted.completeExtraction(allocation.ref);
    await restarted.deleteStorage(allocation.ref);
    await restarted.deleteStorage(allocation.ref);
    expect(await restarted.listStorage()).toHaveLength(0);
    await rm(storage.options.checkpointRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { authorizeCheckpointDownload } from "./download-authority";
import { downloadFixture } from "./filesystem-download-fixture";

test("source header is checked separately from the new destination operation", async () => {
  const f = await downloadFixture();
  try {
    expect(() => authorizeCheckpointDownload(f.header, f.binding, f.mounts)).not.toThrow();
    expect(() =>
      authorizeCheckpointDownload({ ...f.header, checkpoint_id: randomUUID() }, f.binding, f.mounts),
    ).toThrow("source");
    expect(() =>
      authorizeCheckpointDownload(
        { ...f.header, workspace_id: f.binding.destination.workspaceId },
        f.binding,
        f.mounts,
      ),
    ).toThrow("source");
    expect(() =>
      authorizeCheckpointDownload({ ...f.header, template_digest: `sha256:${"0".repeat(64)}` }, f.binding, f.mounts),
    ).toThrow("source");
  } finally {
    await f.close();
  }
});

test("header totals and ordered names must match the exact admitted destination policies", async () => {
  const f = await downloadFixture();
  try {
    expect(() =>
      authorizeCheckpointDownload({ ...f.header, mounts: [...f.header.mounts].reverse() }, f.binding, f.mounts),
    ).toThrow("mount");
    expect(() => authorizeCheckpointDownload({ ...f.header, mounts: [] }, f.binding, f.mounts)).toThrow("mount");
    for (const field of ["maxBytes", "maxFiles"] as const) {
      const mounts = f.mounts.map((mount) => ({ ...mount, policy: { ...mount.policy, [field]: 1 } }));
      expect(() => authorizeCheckpointDownload(f.header, f.binding, mounts)).toThrow(field);
    }
  } finally {
    await f.close();
  }
});

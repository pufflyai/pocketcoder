import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExecSpecSchema } from "./protocol-exec";

const base = {
  setup: [],
  harness: { command: ["true"], env: {} },
  env: {},
  services: {},
  timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
  launch_mode: "restore",
  persistence: { mounts: [], conversation_restore: "filesystem_only" },
  checkpoint_hook: null,
  outputs: {},
};
const lineage = { checkpoint_id: randomUUID(), origin_workspace_id: randomUUID(), transfer: null };

test("restore installation mode must be explicit, even when no transfer grant is present", () => {
  expect(ExecSpecSchema.safeParse({ ...base, restore: lineage }).success).toBe(false);
  for (const mode of ["provider_installed", "controller_archive"] as const)
    expect(ExecSpecSchema.parse({ ...base, restore: { ...lineage, mode } }).restore).toEqual({ ...lineage, mode });
  expect(ExecSpecSchema.safeParse({ ...base, restore: { ...lineage, mode: "automatic" } }).success).toBe(false);
});

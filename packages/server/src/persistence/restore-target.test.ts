import { describe, expect, test } from "bun:test";
import { type CheckpointManifest, snapshotOf, type TemplateSnapshot } from "@pstdio/pocketcoder-contracts";
import { fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { upgradeIncompatibility } from "./restore-target";

const source = snapshotOf(fixtureTemplatePersistent());

function target(change: (spec: TemplateSnapshot["spec"]) => void) {
  const snapshot = structuredClone({ ...source, version: "1.1.0", digest: "sha256:target" });
  change(snapshot.spec);
  return snapshot;
}

function manifest(patch: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    format: "pocketcoder-checkpoint/v1",
    checkpoint_id: crypto.randomUUID(),
    template_digest: source.digest,
    mounts: [{ name: "worktree", entries: [] }],
    logical_bytes: 0,
    file_count: 0,
    ...patch,
  };
}

describe("upgradeIncompatibility", () => {
  test("accepts a new image, new resources and larger limits", () => {
    const next = target((spec) => {
      spec.image = `example.test/fixture-persistent@sha256:${"c".repeat(64)}`;
      spec.resources = { ...spec.resources, cpu: "2" };
      for (const mount of spec.persistence.mounts) mount.maxFiles += 1;
    });
    expect(upgradeIncompatibility(source, next, manifest())).toBeNull();
  });

  test("rejects a different conversation restore mode", () => {
    const next = target((spec) => {
      spec.persistence.conversationRestore = "unknown";
    });
    expect(upgradeIncompatibility(source, next, null)).toBe("session_format");
  });

  test("rejects a moved agent state file", () => {
    const next = target((spec) => {
      Object.assign(spec, { agent: { stateFile: "/workspace/.agent/state.json" } });
    });
    expect(upgradeIncompatibility(source, next, null)).toBe("session_format");
  });

  test("rejects added or renamed mounts", () => {
    const added = target((spec) => {
      spec.persistence.mounts.push({ name: "extra", target: "/extra", maxBytes: 1, maxFiles: 1 });
    });
    const renamed = target((spec) => {
      for (const mount of spec.persistence.mounts) mount.name = "renamed";
    });
    expect(upgradeIncompatibility(source, added, null)).toBe("persistence_mounts");
    expect(upgradeIncompatibility(source, renamed, null)).toBe("persistence_mounts");
  });

  test("rejects a different file owner", () => {
    const next = target((spec) => {
      spec.security.uid += 1;
    });
    expect(upgradeIncompatibility(source, next, null)).toBe("file_ownership");
  });

  test("rejects a manifest written for another template or mount layout", () => {
    const next = target(() => {});
    expect(upgradeIncompatibility(source, next, manifest({ template_digest: "sha256:other" }))).toBe(
      "checkpoint_manifest",
    );
    expect(upgradeIncompatibility(source, next, manifest({ mounts: [] }))).toBe("checkpoint_manifest");
  });
});

import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, Store, WorkspaceCheckpointRow, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { templateSnapshotOf } from "../workspaces/service";
import { upgradeIncompatibility } from "./restore-target";

// Every conversation with a ready checkpoint stays resumable. A workspace restored from a
// checkpoint that never connected holds no newer state, so resuming it resumes that checkpoint.
export async function resumeCheckpoint(store: Store, principal: PrincipalRow, source: WorkspaceRow) {
  const [own] = await store.listCheckpoints(principal.id, { workspaceId: source.id, state: "ready" });
  if (own) return own;
  if (source.restoredFromCheckpointId && source.connectedAt === null) {
    const restored = await store.getCheckpoint(source.restoredFromCheckpointId);
    if (restored?.principalId === principal.id && restored.state === "ready") return restored;
  }
  throw new ApiError("checkpoint.none_ready", "Workspace has no ready checkpoint.");
}

// Resume keeps the checkpoint's version unless it can no longer launch: the version is retired, or
// the provider refused the last launch. Then it moves to the newest compatible version, skipping the
// versions already known not to launch. Returns undefined when nothing needs to change.
export async function healedTemplateVersion(store: Store, checkpoint: WorkspaceCheckpointRow, source: WorkspaceRow) {
  const pinned = checkpoint.templateSnapshot;
  const current = await store.getTemplate(pinned.name, pinned.version);
  const refused = source.reasonCode === "launch_refused";
  if (!refused && current?.status !== "retired") return undefined;

  const unusable = new Set([pinned.digest, ...(refused ? [source.templateSnapshot.digest] : [])]);
  const candidates = (await store.listTemplates([pinned.name]))
    .filter((template) => template.status !== "retired" && !unusable.has(template.digest))
    .reverse();
  let rejected: { version: string; reason: string } | undefined;
  for (const candidate of candidates) {
    const reason = upgradeIncompatibility(pinned, templateSnapshotOf(candidate), checkpoint.manifest);
    if (!reason) return candidate.version;
    rejected ??= { version: candidate.version, reason };
  }
  if (!rejected) return undefined;
  throw new ApiError(
    "restore.incompatible",
    `Template ${pinned.name}@${rejected.version} cannot restore this checkpoint.`,
    {
      reason: rejected.reason,
      checkpoint_id: checkpoint.id,
      template_version: rejected.version,
    },
  );
}

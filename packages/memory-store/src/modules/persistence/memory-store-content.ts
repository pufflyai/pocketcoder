import type { MemoryState } from "../../state/memory-store-base";

export function createContentPurge(context: MemoryState) {
  return {
    async listWorkspaceStorage(workspaceId: string) {
      return [...context.storage.values()].filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row }));
    },
    async purgeWorkspaceContent(workspaceId: string, at: Date) {
      const workspace = context.workspaces.get(workspaceId);
      if (!workspace?.purgeRequestedAt) throw new Error("Purge has not been admitted");
      context.logs.delete(workspaceId);
      context.logBytes.delete(workspaceId);
      context.outputs.delete(workspaceId);
      context.conversations.delete(workspaceId);
      context.conversationBytes.delete(workspaceId);
      context.networkEvents.delete(workspaceId);
      context.outbox = context.outbox.filter((row) => row.workspaceId !== workspaceId);
      context.conversationStates.set(workspaceId, {
        workspaceId,
        status: "deleted",
        expiresAt: null,
        deletedAt: at,
        updatedAt: at,
      });
      for (const checkpoint of context.checkpoints.values()) {
        if (checkpoint.workspaceId === workspaceId)
          Object.assign(checkpoint, { manifest: null, manifestDigest: null, sourceProvenance: null, label: null });
      }
      Object.assign(workspace, {
        launchInput: null,
        outputs: {},
        metadata: {},
        health: {},
        failureLogTail: null,
        failureLogTailTruncated: false,
        failureLastLogSeq: null,
        sourceDescriptor: null,
        resolvedSource: null,
        registrationDigest: null,
        reconnectDigest: null,
        updatedAt: at,
      });
    },
  };
}

import { ApiError, managed, type WorkspaceCreateRequest } from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

type Candidate = Awaited<ReturnType<Store["managed"]["recovery"]["candidates"]>>[number];

// The existing workspace service creates and stops compute; tests may launch through a fixture driver.
export interface PlacementLauncher {
  create(principal: PrincipalRow, body: WorkspaceCreateRequest, idempotencyKey: string): Promise<WorkspaceRow>;
  stop(principal: PrincipalRow, workspaceId: string): Promise<void>;
}

const live = (workspace: WorkspaceRow | null, incarnationId: string) =>
  Boolean(
    workspace &&
      workspace.state === "ready" &&
      !workspace.terminalAt &&
      !workspace.runtimeRegistration?.endedAt &&
      workspace.runtimeRegistration?.incarnationId === incarnationId,
  );
// A socket failure alone is not replacement: only ended runtimes or ended workspaces are.
const ended = (workspace: WorkspaceRow | null) =>
  !workspace ||
  Boolean(workspace.terminalAt || workspace.runtimeRegistration?.endedAt || workspace.state === "terminating");

// The one placement owner for managed sessions. Each step is a durable compare-and-set on the
// session row, so a crash between steps resumes from the recorded placement on the next tick.
// Accepted requests keep their logical identities; only proved never-started work is dispatched
// again, through the existing dispatcher and its binding-revision checks.
export function createSessionRecovery(deps: {
  store: Store;
  launcher: PlacementLauncher;
  now?: () => Date;
  onError?: (error: unknown) => void;
}) {
  const { store, launcher } = deps;
  const recovery = store.managed.recovery;
  const now = () => deps.now?.() ?? new Date();

  async function principalOf(candidate: Candidate) {
    const principal = await store.getPrincipal(candidate.id.principalId);
    if (!principal || principal.disabledAt) throw new ApiError("principal.not_found", "Session owner is unavailable.");
    return principal;
  }

  async function replace(candidate: Candidate, binding: NonNullable<Candidate["binding"]>) {
    const workspace = await store.getWorkspace(binding.workspaceId);
    if (live(workspace, binding.incarnationId)) {
      if (candidate.session.state !== "ready") await recovery.transition(candidate.id, "ready", null);
      return;
    }
    if (!ended(workspace)) return;
    // Fence the old writer first. Its credentials are revoked as the workspace terminates.
    if (workspace && !workspace.terminalAt) {
      if (workspace.state !== "terminating") await launcher.stop(await principalOf(candidate), workspace.id);
      return;
    }
    const identity = { ...candidate.id, workspaceId: binding.workspaceId, generation: binding.generation };
    await store.managed.capacity.processStopped(identity, binding.incarnationId, now());
    // Binding rejects this while any old credential is still pending revocation.
    await store.managed.sessions.bind(candidate.id, candidate.bindingRevision, null);
  }

  // Binds the recorded workspace once it is ready, or gives up on one that ended before that.
  async function continuePlacement(candidate: Candidate, placement: NonNullable<Candidate["placement"]>) {
    const workspace = await store.getWorkspace(placement.workspaceId);
    if (!workspace || workspace.terminalAt) {
      await recovery.failPlacement(candidate.id, placement.workspaceId);
      return;
    }
    await store.managed.capacity.place({
      ...candidate.id,
      workspaceId: workspace.id,
      generation: placement.generation,
    });
    const incarnationId = workspace.runtimeRegistration?.incarnationId;
    if (workspace.state !== "ready" || !incarnationId || !workspace.runtimeRegistration?.readyAt) return;
    await store.managed.sessions.bind(candidate.id, candidate.bindingRevision, {
      workspaceId: workspace.id,
      incarnationId,
      generation: placement.generation,
    });
    await recovery.placed(candidate.id, workspace.id);
  }

  // Close is durable: every tick stops compute the session owns alone until it has ended, and
  // records this session's process stop on shared compute once its requests are terminal.
  async function stopClosed(candidate: Candidate) {
    for (const id of candidate.ownedWorkspaceIds) {
      const workspace = await store.getWorkspace(id);
      if (workspace && !workspace.terminalAt && workspace.state !== "terminating")
        await launcher.stop(await principalOf(candidate), id);
    }
    const binding = candidate.binding;
    if (!binding || candidate.ownedWorkspaceIds.includes(binding.workspaceId) || candidate.openRequests) return;
    const identity = { ...candidate.id, workspaceId: binding.workspaceId, generation: binding.generation };
    await store.managed.capacity.processStopped(identity, binding.incarnationId, now());
  }

  async function place(candidate: Candidate) {
    if (candidate.session.state === "failed" && !candidate.resumeRequested) return;
    if (candidate.queueCount === 0 && !candidate.resumeRequested) return;
    if (candidate.placement) return continuePlacement(candidate, candidate.placement);
    const template = (await store.listTemplates(null)).find((row) => row.digest === candidate.templateDigest);
    if (!template) throw new ApiError("template.not_found", "The pinned template is unavailable.");
    if (candidate.session.state === "failed") await recovery.transition(candidate.id, "provisioning", null);
    const generation = candidate.lastGeneration + 1;
    // Capacity first: a crash before the intent is recorded finds the same held workspace again.
    const shared = await store.managed.capacity.joinable(candidate.id);
    if (shared) {
      await store.managed.capacity.place({ ...candidate.id, workspaceId: shared, generation });
      await recovery.recordPlacement(candidate.id, {
        workspaceId: shared,
        generation,
        requestedAt: now().toISOString(),
      });
      return;
    }
    // The same key after a crash returns the same workspace instead of launching another.
    const key = `managed-session:${candidate.id.sessionId}:${generation}`;
    const workspace = await launcher.create(
      await principalOf(candidate),
      {
        external_id: key,
        template: { name: template.name, version: template.version },
        metadata: { [managed.MANAGED_SESSION_METADATA]: candidate.id.sessionId },
      },
      key,
    );
    const intent = await recovery.recordPlacement(candidate.id, {
      workspaceId: workspace.id,
      generation,
      requestedAt: now().toISOString(),
    });
    await store.managed.capacity.place({ ...candidate.id, workspaceId: intent.workspaceId, generation });
  }

  return {
    async tick() {
      for (const candidate of await recovery.candidates()) {
        try {
          if (candidate.closing) await stopClosed(candidate);
          else if (candidate.binding) await replace(candidate, candidate.binding);
          else await place(candidate);
        } catch (error) {
          // One session's refusal must not stop placement or recovery of the others.
          if (!(error instanceof ApiError)) throw error;
          deps.onError?.(error);
        }
      }
    },
  };
}

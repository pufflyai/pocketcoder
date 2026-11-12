import { ApiError, managed, type WorkspaceCreateRequest } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity, PrincipalRow, Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

type Candidate = Awaited<ReturnType<Store["managed"]["recovery"]["candidates"]>>[number];

// The existing workspace service creates and stops compute; tests may launch through a fixture driver.
export interface PlacementLauncher {
  create(
    principal: PrincipalRow,
    body: WorkspaceCreateRequest,
    idempotencyKey: string,
    workspaceId?: string,
  ): Promise<WorkspaceRow>;
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
// Installs a bound session's own leases on its workspace and revokes them when it leaves shared compute.
export interface SessionCredentialOwner {
  // True once the session's workspace confirmed every credential it needs.
  deliver(identity: ManagedSessionIdentity, workspaceId: string, generation: number): Promise<boolean>;
  revoke(workspaceId: string, sessionId: string): Promise<void>;
}

export function createSessionRecovery(deps: {
  store: Store;
  launcher: PlacementLauncher;
  credentials?: SessionCredentialOwner;
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

  async function credentialsInstalled(candidate: Candidate, binding: NonNullable<Candidate["binding"]>) {
    if (!deps.credentials) return true;
    try {
      return await deps.credentials.deliver(candidate.id, binding.workspaceId, binding.generation);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      deps.onError?.(error);
      return false;
    }
  }

  async function refreshCredentials(candidate: Candidate, binding: NonNullable<Candidate["binding"]>) {
    // A credentialed session is ready, and its requests dispatch, only while its workspace has
    // confirmed its credentials; losing them sends it back to provisioning until they return.
    if (!(await credentialsInstalled(candidate, binding))) {
      if (candidate.session.state === "ready")
        await recovery.transition(candidate.id, "provisioning", "credentials_pending");
      return;
    }
    if (candidate.session.state !== "ready") await recovery.transition(candidate.id, "ready", null);
    return;
  }

  async function replace(candidate: Candidate, binding: NonNullable<Candidate["binding"]>) {
    const workspace = await store.getWorkspace(binding.workspaceId);
    if (candidate.session.reasonCode === "credentials_refused") return;
    if (candidate.session.reasonCode === "workspace_draining" && workspace && !workspace.terminalAt) return;
    if (
      candidate.templateDigest &&
      !ended(workspace) &&
      candidate.queueCount &&
      workspace?.templateDigest !== candidate.templateDigest
    ) {
      await store.managed.capacity.retire(candidate.id, now());
      return;
    }
    if (live(workspace, binding.incarnationId)) return refreshCredentials(candidate, binding);
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
    let workspace = await store.getWorkspace(placement.workspaceId);
    if (!workspace) {
      const template = (await store.listTemplates(null)).find(
        (row) => row.digest === placement.templateDigest && row.status !== "retired",
      );
      if (!template) {
        await store.managed.capacity.cancelPlacement(candidate.id, placement.workspaceId, now());
        return;
      }
      const key = `managed-session:${candidate.id.sessionId}:${placement.generation}`;
      workspace = await launcher.create(
        await principalOf(candidate),
        {
          external_id: key,
          template: { name: template.name, version: template.version },
          metadata: { [managed.MANAGED_SESSION_METADATA]: candidate.id.sessionId },
        },
        key,
        placement.workspaceId,
      );
    }
    if (workspace.terminalAt) {
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
    await deps.credentials?.revoke(binding.workspaceId, candidate.id.sessionId);
    const identity = { ...candidate.id, workspaceId: binding.workspaceId, generation: binding.generation };
    await store.managed.capacity.processStopped(identity, binding.incarnationId, now());
  }

  async function place(candidate: Candidate) {
    if (candidate.session.state === "failed" && !candidate.resumeRequested) return;
    if (candidate.queueCount === 0 && !candidate.resumeRequested) return;
    if (candidate.placement) return continuePlacement(candidate, candidate.placement);
    if (candidate.session.state === "failed") await recovery.transition(candidate.id, "provisioning", null);
    const intent = await store.managed.capacity.reserve(candidate.id, candidate.lastGeneration + 1, now());
    if (intent) await continuePlacement(candidate, intent);
  }

  async function advance(candidate: Candidate) {
    if (candidate.closing) return stopClosed(candidate);
    if (candidate.binding) return replace(candidate, candidate.binding);
    if (candidate.placement) return continuePlacement(candidate, candidate.placement);
    if (!candidate.templateDigest) return recovery.transition(candidate.id, "suspended", "template_unavailable");
    return place(candidate);
  }

  return {
    async tick() {
      for (const drain of await store.managed.capacity.drains()) {
        const workspace = await store.getWorkspace(drain.workspaceId);
        const principal = await store.getPrincipal(drain.principalId);
        if (workspace && principal && !workspace.terminalAt && workspace.state !== "terminating")
          await launcher.stop(principal, workspace.id);
      }
      const candidates = await recovery.candidates();
      // Closes first: a join in this tick must not land on compute a close is about to stop.
      for (const candidate of [...candidates.filter((c) => c.closing), ...candidates.filter((c) => !c.closing)]) {
        try {
          await advance(candidate);
        } catch (error) {
          // One session's refusal must not stop placement or recovery of the others.
          if (!(error instanceof ApiError)) throw error;
          deps.onError?.(error);
        }
      }
    },
  };
}

import type { WorkspaceSummary } from "./control-plane";
import { relayTarget, type SessionTarget, type TargetRef } from "./session-target";
import { STATUS_KEY, type StatusUi } from "./status";

export interface LiveStatusPoller {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

export interface LiveSessionContext {
  ui: StatusUi;
}

export type LiveStatusPollerFactory = (
  workspace: Pick<WorkspaceSummary, "id" | "change_cursor">,
  ui: StatusUi,
) => LiveStatusPoller;

export class LiveSession {
  private readonly targets: TargetRef;
  private readonly createPoller: LiveStatusPollerFactory;
  private nextIdentity = 0;
  private activeIdentity: number | undefined;
  private context: LiveSessionContext | undefined;
  private poller: LiveStatusPoller | undefined;

  constructor(targets: TargetRef, createPoller: LiveStatusPollerFactory) {
    this.targets = targets;
    this.createPoller = createPoller;
  }

  get identity(): number | undefined {
    return this.activeIdentity;
  }

  async activate(context: LiveSessionContext): Promise<number> {
    this.activeIdentity = ++this.nextIdentity;
    this.context = context;
    await this.stopPoller();
    return this.activeIdentity;
  }

  attachPoller(identity: number, workspace: Pick<WorkspaceSummary, "id" | "change_cursor">): void {
    if (identity !== this.activeIdentity || !this.context) return;
    this.poller = this.createPoller(workspace, this.context.ui);
    this.poller.start();
  }

  pause(): void {
    this.poller?.pause();
  }

  resume(): void {
    this.poller?.resume();
  }

  async applyResolved(
    identity: number | undefined,
    source: SessionTarget,
    workspace: Pick<WorkspaceSummary, "id" | "change_cursor">,
  ): Promise<boolean> {
    if (
      identity === undefined ||
      identity !== this.activeIdentity ||
      !this.context ||
      source.mode !== "relay" ||
      source.workspaceId === workspace.id ||
      this.targets.current !== source
    ) {
      return false;
    }

    await this.stopPoller();
    if (identity !== this.activeIdentity || !this.context || this.targets.current !== source) {
      return false;
    }
    const next = relayTarget(source.baseUrl, source.key, workspace.id);
    if (!this.targets.compareAndSwap(source, next)) return false;

    this.context.ui.setStatus(STATUS_KEY, `ws ${workspace.id.slice(0, 8)}`);
    this.poller = this.createPoller(workspace, this.context.ui);
    this.poller.pause();
    this.poller.start();
    return true;
  }

  async shutdown(): Promise<void> {
    this.activeIdentity = undefined;
    this.context = undefined;
    await this.stopPoller();
  }

  private async stopPoller(): Promise<void> {
    const poller = this.poller;
    this.poller = undefined;
    await poller?.stop();
  }
}

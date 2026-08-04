import type {
	DiscoveredProvider,
	DiscoveredWarmProvider,
	ProviderRef,
	ProviderState,
	WarmRuntimeLaunch,
	WorkspaceDriver,
	WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-contracts";

// Deterministic in-memory driver for scheduler and server tests.

export class FakeDriver implements WorkspaceDriver {
	readonly kind = "fake";
	created: WorkspaceLaunch[] = [];
	warmCreated: WarmRuntimeLaunch[] = [];
	terminated: ProviderRef[] = [];
	stopped: ProviderRef[] = [];
	failNextCreate = false;
	createDelayMs = 0;
	private counter = 0;
	private readonly live = new Map<string, DiscoveredProvider>();
	private readonly stoppedIds = new Set<string>();
	private readonly warm = new Map<string, DiscoveredWarmProvider>();

	async create(launch: WorkspaceLaunch): Promise<ProviderRef> {
		if (this.createDelayMs > 0)
			await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
		if (this.failNextCreate) {
			this.failNextCreate = false;
			throw new Error("fake driver create failure");
		}
		this.created.push(launch);
		this.counter += 1;
		const ref: ProviderRef = { kind: this.kind, id: `fake-${this.counter}` };
		this.live.set(launch.workspace.id, {
			workspaceId: launch.workspace.id,
			templateDigest: launch.workspace.templateDigest,
			ref,
		});
		return ref;
	}

	async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
		this.warmCreated.push(launch);
		this.counter += 1;
		const ref: ProviderRef = {
			kind: this.kind,
			id: `fake-warm-${this.counter}`,
			poolRuntimeId: launch.runtimeId,
		};
		this.warm.set(launch.runtimeId, {
			runtimeId: launch.runtimeId,
			templateDigest: launch.template.digest,
			ref,
		});
		return ref;
	}

	async inspect(ref: ProviderRef): Promise<ProviderState> {
		const exists = [...this.live.values(), ...this.warm.values()].some((p) => p.ref.id === ref.id);
		return {
			exists,
			running: exists && !this.stoppedIds.has(ref.id),
			exitCode: !exists || this.stoppedIds.has(ref.id) ? 0 : null,
		};
	}

	async stop(ref: ProviderRef): Promise<void> {
		this.stopped.push(ref);
		this.stoppedIds.add(ref.id);
	}

	async remove(ref: ProviderRef): Promise<void> {
		this.terminated.push(ref);
		this.stoppedIds.delete(ref.id);
		for (const [wsId, p] of this.live) {
			if (p.ref.id === ref.id) this.live.delete(wsId);
		}
		for (const [id, p] of this.warm) if (p.ref.id === ref.id) this.warm.delete(id);
	}

	async list(): Promise<DiscoveredProvider[]> {
		return [...this.live.values()];
	}

	async listWarm(): Promise<DiscoveredWarmProvider[]> {
		return [...this.warm.values()];
	}

	inputFor(workspaceId: string) {
		return this.created.find((l) => l.workspace.id === workspaceId)?.input;
	}
}

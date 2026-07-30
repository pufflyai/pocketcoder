import type {
	DiscoveredProvider,
	ProviderRef,
	ProviderState,
	WorkspaceDriver,
	WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";

// Deterministic in-memory driver for scheduler and server tests.

export class FakeDriver implements WorkspaceDriver {
	readonly kind = "fake";
	created: WorkspaceLaunch[] = [];
	terminated: ProviderRef[] = [];
	failNextCreate = false;
	private counter = 0;
	private readonly live = new Map<string, DiscoveredProvider>();

	async create(launch: WorkspaceLaunch): Promise<ProviderRef> {
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

	async inspect(ref: ProviderRef): Promise<ProviderState> {
		const exists = [...this.live.values()].some((p) => p.ref.id === ref.id);
		return { exists, running: exists, exitCode: exists ? null : 0 };
	}

	async terminate(ref: ProviderRef): Promise<void> {
		this.terminated.push(ref);
		for (const [wsId, p] of this.live) {
			if (p.ref.id === ref.id) this.live.delete(wsId);
		}
	}

	async list(): Promise<DiscoveredProvider[]> {
		return [...this.live.values()];
	}

	inputFor(workspaceId: string) {
		return this.created.find((l) => l.workspace.id === workspaceId)?.input;
	}
}

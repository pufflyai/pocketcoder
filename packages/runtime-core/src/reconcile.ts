import type { WorkspaceDriver } from "./driver";
import type { Store } from "./types";

// Server-restart recovery: reconcile PostgreSQL state with provider objects.
// Workspaces with a live provider wait for their supervisor to reconnect
// inside the disconnect grace; workspaces whose provider vanished fail.

export interface ReconcileDeps {
	store: Store;
	driver: WorkspaceDriver;
	now?: () => Date;
	log?: (msg: string) => void;
}

export async function reconcileProviders(deps: ReconcileDeps): Promise<void> {
	const now = deps.now ? deps.now() : new Date();
	const rows = await deps.store.listNonterminal();
	const discovered = await deps.driver.list();
	const byWorkspace = new Map(discovered.map((d) => [d.workspaceId, d]));
	const known = new Set(rows.map((r) => r.id));

	for (const found of discovered) {
		if (!known.has(found.workspaceId)) {
			// Unknown objects are never adopted; they are quarantined for the
			// operator and logged loudly.
			deps.log?.(
				`reconcile: unknown provider object for workspace ${found.workspaceId}; leaving for inspection`,
			);
		}
	}

	for (const row of rows) {
		if (row.state === "queued") continue;
		const found = byWorkspace.get(row.id);
		if (found && found.templateDigest !== row.templateDigest) {
			deps.log?.(`reconcile: template digest mismatch for ${row.id}; failing workspace`);
		}
		const lost = !found || found.templateDigest !== row.templateDigest;
		if (lost && row.state === "terminating") {
			// The provider is gone and termination was already requested;
			// honor the recorded intent (e.g. canceled) instead of failing.
			await deps.store.transition(row.id, {
				from: ["terminating"],
				to: row.terminalIntent ?? "failed",
				reason: row.reasonCode ?? "provider_lost",
				at: now,
			});
			continue;
		}
		if (lost && (row.state === "connected" || row.state === "ready")) {
			await deps.store.transition(row.id, {
				from: [row.state],
				to: "failed",
				reason: "provider_lost",
				at: now,
			});
			continue;
		}
		if ((row.state === "connected" || row.state === "ready") && !row.disconnectedAt) {
			// The old connection died with the previous server process; start
			// the reconnect grace now.
			await deps.store.updateWorkspace(row.id, { disconnectedAt: now }, now);
		}
	}
}

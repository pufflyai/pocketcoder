import type { MetricSink } from "./metrics";

export async function measureReconciliation(
	metrics: MetricSink | undefined,
	kind: "persistence" | "provider",
	skipped: boolean,
	reconcile: () => Promise<void>,
): Promise<void> {
	const startedAt = performance.now();
	let result = skipped ? "skipped" : "succeeded";
	try {
		if (!skipped) await reconcile();
	} catch (error) {
		result = "failed";
		throw error;
	} finally {
		const labels = { kind, result };
		metrics?.increment("reconciliation.total", labels);
		metrics?.observe("reconciliation.duration_ms", performance.now() - startedAt, labels);
	}
}

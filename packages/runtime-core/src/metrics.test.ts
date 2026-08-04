import { expect, test } from "bun:test";
import { RuntimeMetrics } from "./metrics";

test("runtime metrics retain labeled counters and timing summaries", () => {
	const metrics = new RuntimeMetrics();
	metrics.increment("admission.total", { result: "accepted" });
	metrics.increment("admission.total", { result: "accepted" });
	metrics.observe("workspace.queue_delay_ms", 125, { template: "pi" });
	metrics.observe("workspace.queue_delay_ms", 75, { template: "pi" });

	expect(metrics.snapshot()).toEqual({
		counters: { 'admission.total{result="accepted"}': 2 },
		timings: {
			'workspace.queue_delay_ms{template="pi"}': { count: 2, total: 200, min: 75, max: 125 },
		},
	});
});

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSink {
	increment(name: string, labels?: MetricLabels, value?: number): void;
	observe(name: string, value: number, labels?: MetricLabels): void;
}

interface TimingSummary {
	count: number;
	total: number;
	min: number;
	max: number;
}

function metricKey(name: string, labels: MetricLabels = {}) {
	const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length === 0) return name;
	const rendered = entries
		.map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`)
		.join(",");
	return `${name}{${rendered}}`;
}

export class RuntimeMetrics implements MetricSink {
	private readonly counters = new Map<string, number>();
	private readonly timings = new Map<string, TimingSummary>();

	increment(name: string, labels: MetricLabels = {}, value = 1): void {
		const key = metricKey(name, labels);
		this.counters.set(key, (this.counters.get(key) ?? 0) + value);
	}

	observe(name: string, value: number, labels: MetricLabels = {}): void {
		const key = metricKey(name, labels);
		const current = this.timings.get(key);
		this.timings.set(key, {
			count: (current?.count ?? 0) + 1,
			total: (current?.total ?? 0) + value,
			min: current ? Math.min(current.min, value) : value,
			max: current ? Math.max(current.max, value) : value,
		});
	}

	snapshot() {
		return {
			counters: Object.fromEntries(this.counters),
			timings: Object.fromEntries(this.timings),
		};
	}
}

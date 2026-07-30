import {
	type ParsedTemplate,
	parseTemplateManifest,
	snapshotOf,
} from "@pstdio/pocketcoder-contracts";

// Two distinct fixture templates proving template selection changes the
// environment (image, setup, harness) without changing the execution path.

const PLACEHOLDER_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

export function fixtureTemplateEcho(overrides?: { version?: string }): ParsedTemplate {
	return parseTemplateManifest({
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: { name: "fixture-echo", description: "Echo harness fixture" },
		spec: {
			version: overrides?.version ?? "1.0.0",
			image: `example.test/fixture-echo@sha256:${PLACEHOLDER_DIGEST}`,
			harness: {
				command: ["/bin/echo-harness"],
			},
			resources: { cpu: "1", memory: "512Mi" },
			services: {
				agent: {
					baseUrl: "http://127.0.0.1:3284",
					routes: [
						{ method: "GET", path: "/status" },
						{ method: "GET", path: "/messages", query: ["after"] },
						{ method: "POST", path: "/message" },
					],
				},
			},
		},
	});
}

export function fixtureTemplateSleep(): ParsedTemplate {
	return parseTemplateManifest({
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: { name: "fixture-sleep", description: "Sleep harness fixture" },
		spec: {
			version: "1.0.0",
			image: `example.test/fixture-sleep@sha256:${OTHER_DIGEST}`,
			setup: [{ name: "prepare", command: ["/bin/true"] }],
			harness: {
				command: ["/bin/sleep", "3600"],
			},
			resources: { cpu: "1", memory: "256Mi" },
			timeouts: { start: "1m", maxAge: "10m", idle: "5m" },
			services: {
				agent: {
					baseUrl: "http://127.0.0.1:3284",
					routes: [{ method: "GET", path: "/status" }],
				},
			},
		},
	});
}

export function fixtureSnapshot(parsed: ParsedTemplate = fixtureTemplateEcho()) {
	return snapshotOf(parsed);
}

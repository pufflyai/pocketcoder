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
						{ method: "GET", path: "/events", responseMode: "stream" },
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

export function fixtureTemplateTerminal(): ParsedTemplate {
	const manifest = fixtureTemplateEcho().manifest;
	return parseTemplateManifest({
		...manifest,
		metadata: { name: "fixture-terminal", description: "Terminal-enabled fixture" },
		spec: {
			...manifest.spec,
			version: "1.0.0",
			terminal: {
				command: ["/bin/sh"],
				cwd: "/tmp",
				maxSessions: 2,
				idleTimeout: "10m",
			},
		},
	});
}

export function fixtureTemplatePersistent(): ParsedTemplate {
	return parseTemplateManifest({
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: {
			name: "fixture-persistent",
			description: "Persistent worktree fixture",
		},
		spec: {
			version: "1.0.0",
			image: `example.test/fixture-persistent@sha256:${PLACEHOLDER_DIGEST}`,
			setup: [
				{
					name: "create-only",
					command: ["/bin/true"],
					runOn: ["create"],
				},
				{
					name: "restore-only",
					command: ["/bin/true"],
					runOn: ["restore"],
				},
			],
			harness: { command: ["/bin/echo-harness"], cwd: "/workspace" },
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
			security: {
				writableMemoryPaths: ["/tmp"],
			},
			persistence: {
				mounts: [
					{
						name: "worktree",
						target: "/workspace",
						maxBytes: 1_048_576,
						maxFiles: 1000,
					},
				],
				conversationRestore: "filesystem_only",
				checkpoint: { retention: "1h" },
			},
			outputs: {
				commit: { type: "gitSha" },
				branch: { type: "string", maxLength: 256 },
			},
		},
	});
}

export function fixtureSnapshot(parsed: ParsedTemplate = fixtureTemplateEcho()) {
	return snapshotOf(parsed);
}

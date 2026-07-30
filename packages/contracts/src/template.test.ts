import { describe, expect, test } from "bun:test";
import { findRoute, parseDurationMs, parseTemplateManifest, snapshotOf } from "./index";

const DIGEST = "a".repeat(64);

function baseManifest(): Record<string, unknown> {
	return {
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: { name: "fixture", description: "test" },
		spec: {
			version: "1.0.0",
			image: `registry.test/agent@sha256:${DIGEST}`,
			harness: { command: ["agentapi", "server", "--", "claude"] },
			resources: { cpu: "2", memory: "2Gi" },
			services: {
				agent: {
					baseUrl: "http://127.0.0.1:3284",
					routes: [
						{ method: "GET", path: "/status" },
						{ method: "POST", path: "/message" },
					],
				},
			},
		},
	};
}

describe("template manifest", () => {
	test("parses with defaults applied", () => {
		const parsed = parseTemplateManifest(baseManifest());
		expect(parsed.manifest.spec.timeouts.maxAge).toBe("2h");
		expect(parsed.manifest.spec.security.uid).toBe(10001);
		expect(parsed.manifest.spec.setup).toEqual([]);
		expect(parsed.manifest.spec.command[0]).toContain("pocketcoder-agent");
		expect(parsed.digest.startsWith("sha256:")).toBe(true);
	});

	test("digest is independent of key order", () => {
		const a = parseTemplateManifest(baseManifest());
		const reordered = JSON.parse(JSON.stringify(baseManifest())) as Record<string, unknown>;
		const spec = reordered.spec as Record<string, unknown>;
		const { version, ...rest } = spec;
		reordered.spec = { ...rest, version };
		const b = parseTemplateManifest(reordered);
		expect(a.digest).toBe(b.digest);
	});

	test("digest changes when content changes", () => {
		const m = baseManifest();
		(m.spec as { version: string }).version = "1.0.1";
		expect(parseTemplateManifest(m).digest).not.toBe(parseTemplateManifest(baseManifest()).digest);
	});

	test("rejects images that are not digest-pinned", () => {
		const m = baseManifest();
		(m.spec as { image: string }).image = "registry.test/agent:latest";
		expect(() => parseTemplateManifest(m)).toThrow();
	});

	test("rejects non-loopback service baseUrl", () => {
		const m = baseManifest();
		const services = (m.spec as { services: Record<string, { baseUrl: string }> }).services;
		(services.agent as { baseUrl: string }).baseUrl = "http://10.0.0.5:3284";
		expect(() => parseTemplateManifest(m)).toThrow();
	});

	test("rejects traversal and unnormalized route paths", () => {
		for (const path of ["../etc", "/a/../b", "//double", "/query?x=1", "/space here"]) {
			const m = baseManifest();
			const services = (
				m.spec as {
					services: Record<string, { routes: Array<{ method: string; path: string }> }>;
				}
			).services;
			services.agent = {
				routes: [{ method: "GET", path }],
			} as never;
			expect(() => parseTemplateManifest(m)).toThrow();
		}
	});

	test("rejects secret-looking env literals but allows references", () => {
		const bad = baseManifest();
		(bad.spec as { env?: Record<string, string> }).env = { API_TOKEN: "sk-live-abc" };
		expect(() => parseTemplateManifest(bad)).toThrow();

		const good = baseManifest();
		(good.spec as { env?: Record<string, string> }).env = {
			API_TOKEN: "secretRef:agentgateway/token",
		};
		expect(() => parseTemplateManifest(good)).not.toThrow();
	});

	test("custom setup commands and harness survive the snapshot", () => {
		const m = baseManifest();
		(m.spec as { setup?: unknown }).setup = [
			{ name: "install", command: ["bun", "install"], timeoutSeconds: 60 },
		];
		const snapshot = snapshotOf(parseTemplateManifest(m));
		expect(snapshot.spec.setup[0]?.command).toEqual(["bun", "install"]);
		expect(snapshot.spec.harness.command[0]).toBe("agentapi");
	});

	test("findRoute matches exactly and only declared routes", () => {
		const snapshot = snapshotOf(parseTemplateManifest(baseManifest()));
		expect(findRoute(snapshot, "agent", "GET", "/status")).not.toBeNull();
		expect(findRoute(snapshot, "agent", "DELETE", "/status")).toBeNull();
		expect(findRoute(snapshot, "agent", "GET", "/statusx")).toBeNull();
		expect(findRoute(snapshot, "other", "GET", "/status")).toBeNull();
	});
});

describe("durations", () => {
	test("parses units", () => {
		expect(parseDurationMs("15s")).toBe(15_000);
		expect(parseDurationMs("20m")).toBe(1_200_000);
		expect(parseDurationMs("2h")).toBe(7_200_000);
		expect(() => parseDurationMs("2 days")).toThrow();
	});
});

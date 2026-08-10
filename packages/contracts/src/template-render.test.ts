import { describe, expect, test } from "bun:test";
import { renderTemplateManifest } from "./template-render";

const PLACEHOLDER = `registry.test/agent@sha256:${"0".repeat(64)}`;
const IMAGE = `registry.test/agent@sha256:${"1".repeat(64)}`;

function manifest() {
	return {
		apiVersion: "pocketcoder.dev/v1alpha1",
		kind: "Template",
		metadata: { name: "render-fixture", description: "render test" },
		spec: {
			version: "1.2.3",
			image: PLACEHOLDER,
			agent: {
				type: "codex",
				command: ["codex"],
				env: { MODEL: "default", FEATURE: "off" },
			},
			resources: { cpu: "1", memory: "1Gi" },
			security: { readOnlyRoot: true },
			source: null,
			maxLaunchInputBytes: 65_536,
		},
	};
}

describe("template rendering", () => {
	test("normalizes content and derives a stable immutable version", () => {
		const first = renderTemplateManifest(manifest(), { image: IMAGE });
		const second = renderTemplateManifest(structuredClone(manifest()), { image: IMAGE });

		expect(`${first.canonical}\n`).toBe(`${second.canonical}\n`);
		expect(first.manifest.spec.version).toMatch(/^1\.2\.3-[0-9a-f]{12}$/);
		expect(first.manifest.spec.image).toBe(IMAGE);
	});

	test("preserves typed JSON-Pointer overrides and changes identity with content", () => {
		const baseline = renderTemplateManifest(manifest(), { image: IMAGE });
		const changed = renderTemplateManifest(manifest(), {
			image: IMAGE,
			set: [
				'/spec/agent/env={"MODEL":"gpt-5","FEATURE":"on"}',
				'/spec/agent/command=["codex","exec"]',
				"/spec/security/readOnlyRoot=false",
				"/spec/source=null",
				"/spec/maxLaunchInputBytes=1024",
			],
		});

		expect(changed.manifest.spec.agent?.env).toMatchObject({ MODEL: "gpt-5", FEATURE: "on" });
		expect(changed.manifest.spec.agent?.command).toEqual(["codex", "exec"]);
		expect(changed.manifest.spec.security.readOnlyRoot).toBe(false);
		expect(changed.manifest.spec.source).toBeNull();
		expect(changed.manifest.spec.maxLaunchInputBytes).toBe(1024);
		expect(changed.manifest.spec.version).not.toBe(baseline.manifest.spec.version);
	});

	test("rejects placeholders, bad pointers, untyped values, and invalid final manifests", () => {
		expect(() => renderTemplateManifest(manifest())).toThrow("--image is required");
		expect(() =>
			renderTemplateManifest(manifest(), { image: "registry.test/agent:latest" }),
		).toThrow();
		expect(() =>
			renderTemplateManifest(manifest(), { image: IMAGE, set: ["/spec/missing=true"] }),
		).toThrow("does not exist");
		expect(() =>
			renderTemplateManifest(manifest(), { image: IMAGE, set: ["/spec/resources/cpu=not-json"] }),
		).toThrow("valid JSON");
		expect(() =>
			renderTemplateManifest(manifest(), { image: IMAGE, set: ["/spec/resources/cpu=false"] }),
		).toThrow();
	});

	test("requires a plain release triplet before automatic versioning", () => {
		const input = manifest();
		input.spec.version = "1.2.3-existing";
		expect(() => renderTemplateManifest(input, { image: IMAGE })).toThrow(
			"spec.version must be a release triplet",
		);
	});
});

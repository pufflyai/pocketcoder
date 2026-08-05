import type { z } from "zod";
import { canonicalJson, digestOf } from "./canonical";
import { parseDurationMs } from "./duration";
import { templateServices } from "./template-runtime";
import {
	type TemplateManifest,
	TemplateManifestBaseSchema,
	type TemplateService,
	type TemplateServiceRoute,
	type TemplateSpec,
	TemplateSpecSchema,
	type TimeoutsSchema,
} from "./template-schema";
import { validateTemplateSpec } from "./template-validation";

export { agentApiHarness, isAgentApiNative, templateServices } from "./template-runtime";
export {
	type Agent,
	AgentSchema,
	type CheckpointHook,
	CheckpointHookSchema,
	DurationSchema,
	type Harness,
	HarnessSchema,
	ResourcesSchema,
	SecuritySchema,
	ServiceRouteSchema,
	ServiceSchema,
	type SetupStep,
	SetupStepSchema,
	type SourceSpec,
	SourceSpecSchema,
	secretMountPath,
	type TemplateManifest,
	type TemplateService,
	type TemplateServiceRoute,
	type TemplateSpec,
	TemplateSpecSchema,
	type Terminal,
	TerminalSchema,
	TimeoutsSchema,
} from "./template-schema";
export { isNormalizedPath } from "./template-validation";

export const TemplateManifestSchema = TemplateManifestBaseSchema.superRefine((manifest, ctx) => {
	validateTemplateSpec(manifest.spec, ctx);
});

export interface ParsedTemplate {
	manifest: TemplateManifest;
	digest: string;
	canonical: string;
}

// Parse and normalize a manifest, computing its canonical digest. Content
// under an existing (name, version) may never change; the digest detects it.
export function parseTemplateManifest(input: unknown): ParsedTemplate {
	const manifest = TemplateManifestSchema.parse(input);
	const canonical = canonicalJson(manifest);
	return { manifest, digest: digestOf(manifest), canonical };
}

// The immutable snapshot stored on each workspace row. It contains everything
// the lifecycle, relay, and supervisor need, and nothing secret.
export interface TemplateSnapshot {
	name: string;
	version: string;
	digest: string;
	spec: TemplateSpec;
}

export function normalizeTemplateSnapshot(snapshot: TemplateSnapshot): TemplateSnapshot {
	return { ...snapshot, spec: TemplateSpecSchema.parse(snapshot.spec) };
}

export function snapshotOf(parsed: ParsedTemplate): TemplateSnapshot {
	return {
		name: parsed.manifest.metadata.name,
		version: parsed.manifest.spec.version,
		digest: parsed.digest,
		spec: parsed.manifest.spec,
	};
}

export function timeoutMs(snapshot: TemplateSnapshot, key: keyof z.infer<typeof TimeoutsSchema>) {
	return parseDurationMs(snapshot.spec.timeouts[key]);
}

// Finds the exact declared route for a relay request, or null.
export function findRoute(
	snapshot: TemplateSnapshot,
	service: string,
	method: string,
	path: string,
): { service: TemplateService; route: TemplateServiceRoute } | null {
	const foundService = templateServices(snapshot.spec)[service];
	if (!foundService) return null;
	const route = foundService.routes.find(
		(candidate) => candidate.method === method && candidate.path === path,
	);
	if (!route) return null;
	return { service: foundService, route };
}

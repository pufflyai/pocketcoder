import { z } from "zod";
import { canonicalJson, digestOf } from "./canonical";
import { isDuration, parseDurationMs } from "./duration";

// Template manifests (`pocketcoder.dev/v1alpha1 Template`) are reviewed
// deployment resources. Callers select a template by name/version; they can
// never submit an image, command, mount, network, privilege, or provider.
//
// The execution surface a template owns:
//   - `spec.command`  container entrypoint (the pocketcoder-agent supervisor);
//   - `spec.setup`    ordered setup commands run before the harness starts;
//   - `spec.harness`  the long-running conversation harness (e.g. AgentAPI
//                     wrapping a coding-agent CLI) supervised as one process
//                     group;
//   - `spec.services` allowlisted loopback routes the control plane may relay.

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const ABS_PATH_RE = /^\/[^\0]*$/;
const SECRETY_ENV_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
// Values with this prefix are opaque references resolved by the deployment
// (e.g. mounted files or agentgateway policy), never literal secrets.
const SECRET_REF_PREFIX = "secretRef:";

export const DurationSchema = z
	.string()
	.refine(isDuration, { message: "expected a duration like 15s, 20m, or 2h" });

const CommandSchema = z.array(z.string().min(1)).min(1);

const EnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());

export const SetupStepSchema = z.object({
	name: z.string().regex(NAME_RE),
	command: CommandSchema,
	timeoutSeconds: z.number().int().positive().max(3600).default(300),
	env: EnvSchema.default({}),
	cwd: z.string().regex(ABS_PATH_RE).optional(),
});

export const HarnessSchema = z.object({
	command: CommandSchema,
	env: EnvSchema.default({}),
	cwd: z.string().regex(ABS_PATH_RE).optional(),
});

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const ServiceRouteSchema = z.object({
	method: z.enum(HTTP_METHODS),
	path: z.string(),
	query: z.array(z.string().min(1)).default([]),
	maxRequestBytes: z
		.number()
		.int()
		.positive()
		.max(16 * 1024 * 1024)
		.default(65_536),
	maxResponseBytes: z
		.number()
		.int()
		.positive()
		.max(16 * 1024 * 1024)
		.default(1_048_576),
	deadlineSeconds: z.number().int().positive().max(300).default(60),
});

export const ServiceSchema = z.object({
	baseUrl: z.string(),
	required: z.boolean().default(true),
	healthPath: z.string().default("/status"),
	routes: z.array(ServiceRouteSchema).min(1),
});

export const SecuritySchema = z.object({
	uid: z.number().int().min(1000).default(10_001),
	gid: z.number().int().min(1000).default(10_001),
	readOnlyRoot: z.boolean().default(true),
	writableMemoryPaths: z.array(z.string().regex(ABS_PATH_RE)).default(["/tmp"]),
	dropCapabilities: z.array(z.string()).default(["ALL"]),
	allowPrivilegeEscalation: z.literal(false).default(false),
	seccomp: z.literal("RuntimeDefault").default("RuntimeDefault"),
});

export const TimeoutsSchema = z.object({
	start: DurationSchema.default("2m"),
	maxAge: DurationSchema.default("2h"),
	idle: DurationSchema.default("20m"),
	disconnectGrace: DurationSchema.default("5m"),
	terminateGrace: DurationSchema.default("15s"),
});

export const ResourcesSchema = z.object({
	cpu: z.string().regex(/^\d+(\.\d+)?m?$/),
	memory: z.string().regex(/^\d+(Mi|Gi)$/),
});

export const TemplateSpecSchema = z.object({
	version: z.string().regex(SEMVER_RE),
	image: z.string().regex(IMAGE_DIGEST_RE, {
		message: "image must be digest-pinned (repo@sha256:<64 hex>)",
	}),
	command: CommandSchema.default([
		"/usr/local/bin/pocketcoder-agent",
		"supervise",
		"--launch-input",
		"/run/pocketcoder/input",
	]),
	setup: z.array(SetupStepSchema).max(32).default([]),
	harness: HarnessSchema,
	env: EnvSchema.default({}),
	resources: ResourcesSchema,
	timeouts: TimeoutsSchema.prefault({}),
	services: z.record(z.string().regex(NAME_RE), ServiceSchema).default({}),
	security: SecuritySchema.prefault({}),
	maxLaunchInputBytes: z.number().int().positive().max(1_048_576).default(65_536),
	compat: z
		.object({
			agent: z.string().optional(),
			agentapi: z.string().optional(),
		})
		.default({}),
});

export const TemplateManifestSchema = z
	.object({
		apiVersion: z.literal("pocketcoder.dev/v1alpha1"),
		kind: z.literal("Template"),
		metadata: z.object({
			name: z.string().regex(NAME_RE),
			description: z.string().max(512).optional(),
		}),
		spec: TemplateSpecSchema,
	})
	.superRefine((manifest, ctx) => {
		for (const [serviceName, service] of Object.entries(manifest.spec.services)) {
			if (!isLoopbackBaseUrl(service.baseUrl)) {
				ctx.addIssue({
					code: "custom",
					path: ["spec", "services", serviceName, "baseUrl"],
					message: "service baseUrl must be a loopback http URL",
				});
			}
			if (!isNormalizedPath(service.healthPath)) {
				ctx.addIssue({
					code: "custom",
					path: ["spec", "services", serviceName, "healthPath"],
					message: "healthPath must be a normalized absolute path",
				});
			}
			const seen = new Set<string>();
			for (const [i, route] of service.routes.entries()) {
				if (!isNormalizedPath(route.path)) {
					ctx.addIssue({
						code: "custom",
						path: ["spec", "services", serviceName, "routes", i, "path"],
						message: "route path must be normalized, absolute, and exact",
					});
				}
				const key = `${route.method} ${route.path}`;
				if (seen.has(key)) {
					ctx.addIssue({
						code: "custom",
						path: ["spec", "services", serviceName, "routes", i],
						message: `duplicate route: ${key}`,
					});
				}
				seen.add(key);
			}
		}
		for (const [where, env] of envSources(manifest.spec)) {
			for (const [key, value] of Object.entries(env)) {
				if (SECRETY_ENV_RE.test(key) && !value.startsWith(SECRET_REF_PREFIX) && value !== "") {
					ctx.addIssue({
						code: "custom",
						path: where,
						message: `env ${key} looks like a secret literal; use a "${SECRET_REF_PREFIX}" reference resolved by the deployment`,
					});
				}
			}
		}
		for (const p of manifest.spec.security.writableMemoryPaths) {
			if (p.includes("..")) {
				ctx.addIssue({
					code: "custom",
					path: ["spec", "security", "writableMemoryPaths"],
					message: "writable paths must not contain ..",
				});
			}
		}
	});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
export type TemplateSpec = z.infer<typeof TemplateSpecSchema>;
export type TemplateService = z.infer<typeof ServiceSchema>;
export type TemplateServiceRoute = z.infer<typeof ServiceRouteSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type Harness = z.infer<typeof HarnessSchema>;

function envSources(spec: TemplateSpec): Array<[Array<string | number>, Record<string, string>]> {
	const sources: Array<[Array<string | number>, Record<string, string>]> = [
		[["spec", "env"], spec.env],
		[["spec", "harness", "env"], spec.harness.env],
	];
	for (const [i, step] of spec.setup.entries()) {
		sources.push([["spec", "setup", i, "env"], step.env]);
	}
	return sources;
}

function isLoopbackBaseUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:") {
		return false;
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		return false;
	}
	return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname === "::1";
}

export function isNormalizedPath(path: string): boolean {
	if (!path.startsWith("/")) return false;
	if (path.includes("..") || path.includes("//")) return false;
	if (/[?#\s]/.test(path)) return false;
	if (/%2e|%2f|%5c/i.test(path)) return false;
	if ([...path].some((character) => character.charCodeAt(0) <= 0x1f)) return false;
	return true;
}

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

export function snapshotOf(parsed: ParsedTemplate): TemplateSnapshot {
	return {
		name: parsed.manifest.metadata.name,
		version: parsed.manifest.spec.version,
		digest: parsed.digest,
		spec: parsed.manifest.spec,
	};
}

export function timeoutMs(
	snapshot: TemplateSnapshot,
	key: keyof z.infer<typeof TimeoutsSchema>,
): number {
	return parseDurationMs(snapshot.spec.timeouts[key]);
}

// Finds the exact declared route for a relay request, or null.
export function findRoute(
	snapshot: TemplateSnapshot,
	service: string,
	method: string,
	path: string,
): { service: TemplateService; route: TemplateServiceRoute } | null {
	const svc = snapshot.spec.services[service];
	if (!svc) return null;
	const route = svc.routes.find((r) => r.method === method && r.path === path);
	if (!route) return null;
	return { service: svc, route };
}

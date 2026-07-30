import { z } from "zod";
import { canonicalJson, digestOf } from "./canonical";
import { isDuration, parseDurationMs } from "./duration";
import {
	LAUNCH_MODES,
	OutputDeclarationSchema,
	type PersistenceMount,
	PersistenceSpecSchema,
} from "./persistence";

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
export function secretMountPath(reference: string): string {
	if (!reference.startsWith(SECRET_REF_PREFIX)) {
		throw new Error("secret reference must start with secretRef:");
	}
	const name = reference.slice(SECRET_REF_PREFIX.length);
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(name) || name.includes("..")) {
		throw new Error("invalid secret reference");
	}
	return `/run/pocketcoder/secrets/${name.replaceAll("/", "%2F")}`;
}

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
	runOn: z.array(z.enum(LAUNCH_MODES)).min(1).default(["create"]),
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

const RepositorySchema = z.object({
	url: z.url().refine((value) => {
		try {
			return new URL(value).username === "" && new URL(value).password === "";
		} catch {
			return false;
		}
	}, "repository URLs must not contain userinfo"),
	credential: z
		.string()
		.startsWith(SECRET_REF_PREFIX)
		.max(256)
		.refine((value) => {
			try {
				secretMountPath(value);
				return true;
			} catch {
				return false;
			}
		}, "credential must be a normalized secret reference")
		.optional(),
});

export const SourceSpecSchema = z.object({
	kind: z.literal("git"),
	destinationMount: z.string().regex(NAME_RE),
	repositories: z.record(z.string().regex(NAME_RE), RepositorySchema),
	allowedRevision: z.literal("branch-tag-or-commit").default("branch-tag-or-commit"),
});

export const CheckpointHookSchema = z.object({
	command: CommandSchema,
	timeoutSeconds: z.number().int().positive().max(300).default(30),
	env: EnvSchema.default({}),
	cwd: z.string().regex(ABS_PATH_RE).optional(),
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
	persistence: PersistenceSpecSchema.prefault({}),
	source: SourceSpecSchema.nullable().default(null),
	checkpointHook: CheckpointHookSchema.optional(),
	outputs: z.record(z.string().regex(NAME_RE), OutputDeclarationSchema).default({}),
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
		validateServices(manifest.spec, ctx);
		validateEnvironment(manifest.spec, ctx);
		validateOutputs(manifest.spec, ctx);
		validateWritableMemoryPaths(manifest.spec, ctx);
		validatePersistence(manifest.spec, ctx);
	});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
export type TemplateSpec = z.infer<typeof TemplateSpecSchema>;
export type TemplateService = z.infer<typeof ServiceSchema>;
export type TemplateServiceRoute = z.infer<typeof ServiceRouteSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
export type Harness = z.infer<typeof HarnessSchema>;
export type SourceSpec = z.infer<typeof SourceSpecSchema>;
export type CheckpointHook = z.infer<typeof CheckpointHookSchema>;

function envSources(spec: TemplateSpec): Array<[Array<string | number>, Record<string, string>]> {
	const sources: Array<[Array<string | number>, Record<string, string>]> = [
		[["spec", "env"], spec.env],
		[["spec", "harness", "env"], spec.harness.env],
	];
	for (const [i, step] of spec.setup.entries()) {
		sources.push([["spec", "setup", i, "env"], step.env]);
	}
	if (spec.checkpointHook) {
		sources.push([["spec", "checkpointHook", "env"], spec.checkpointHook.env]);
	}
	return sources;
}

function validateServices(spec: TemplateSpec, ctx: z.RefinementCtx): void {
	for (const [serviceName, service] of Object.entries(spec.services)) {
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
		validateServiceRoutes(serviceName, service.routes, ctx);
	}
}

function validateServiceRoutes(
	serviceName: string,
	routes: TemplateServiceRoute[],
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const [index, route] of routes.entries()) {
		if (!isNormalizedPath(route.path)) {
			ctx.addIssue({
				code: "custom",
				path: ["spec", "services", serviceName, "routes", index, "path"],
				message: "route path must be normalized, absolute, and exact",
			});
		}
		const key = `${route.method} ${route.path}`;
		if (seen.has(key)) {
			ctx.addIssue({
				code: "custom",
				path: ["spec", "services", serviceName, "routes", index],
				message: `duplicate route: ${key}`,
			});
		}
		seen.add(key);
	}
}

function validateEnvironment(spec: TemplateSpec, ctx: z.RefinementCtx): void {
	for (const [where, env] of envSources(spec)) {
		for (const [key, value] of Object.entries(env)) {
			const literalSecret =
				SECRETY_ENV_RE.test(key) && !value.startsWith(SECRET_REF_PREFIX) && value !== "";
			if (literalSecret) {
				ctx.addIssue({
					code: "custom",
					path: where,
					message: `env ${key} looks like a secret literal; use a "${SECRET_REF_PREFIX}" reference resolved by the deployment`,
				});
			}
			if (value.startsWith(SECRET_REF_PREFIX) && !validSecretReference(value)) {
				ctx.addIssue({
					code: "custom",
					path: where,
					message: `env ${key} has an invalid secret reference`,
				});
			}
		}
	}
}

function validSecretReference(value: string): boolean {
	try {
		secretMountPath(value);
		return true;
	} catch {
		return false;
	}
}

function validateOutputs(spec: TemplateSpec, ctx: z.RefinementCtx): void {
	for (const name of Object.keys(spec.outputs)) {
		if (!SECRETY_ENV_RE.test(name)) continue;
		ctx.addIssue({
			code: "custom",
			path: ["spec", "outputs", name],
			message: "secret-like names are not allowed as durable outputs",
		});
	}
}

function validateWritableMemoryPaths(spec: TemplateSpec, ctx: z.RefinementCtx): void {
	for (const path of spec.security.writableMemoryPaths) {
		if (!path.includes("..")) continue;
		ctx.addIssue({
			code: "custom",
			path: ["spec", "security", "writableMemoryPaths"],
			message: "writable paths must not contain ..",
		});
	}
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

const FORBIDDEN_PERSISTENCE_ROOTS = [
	"/",
	"/run/pocketcoder",
	"/run/pocketcoder/secrets",
	"/proc",
	"/sys",
	"/dev",
];

function pathContains(parent: string, child: string): boolean {
	return child === parent || child.startsWith(`${parent}/`);
}

function validatePersistence(spec: TemplateSpec, ctx: z.RefinementCtx): void {
	const seenNames = new Set<string>();
	const mounts: PersistenceMount[] = spec.persistence.mounts;
	for (const [index, mount] of mounts.entries()) {
		validatePersistenceMount(spec, mounts, mount, index, seenNames, ctx);
	}
	validateSourceMount(spec, mounts, ctx);
	if (
		spec.persistence.conversationRestore === "supported" &&
		(!spec.persistence.sessionCompatibility || mounts.length < 2)
	) {
		ctx.addIssue({
			code: "custom",
			path: ["spec", "persistence", "conversationRestore"],
			message:
				"supported conversation restore requires sessionCompatibility and a separate harness-state mount",
		});
	}
}

function validatePersistenceMount(
	spec: TemplateSpec,
	mounts: PersistenceMount[],
	mount: PersistenceMount,
	index: number,
	seenNames: Set<string>,
	ctx: z.RefinementCtx,
): void {
	const path = ["spec", "persistence", "mounts", index, "target"];
	if (!isNormalizedFilesystemPath(mount.target)) {
		ctx.addIssue({
			code: "custom",
			path,
			message: "target must be a normalized absolute filesystem path",
		});
	}
	if (FORBIDDEN_PERSISTENCE_ROOTS.some((root) => pathContains(root, mount.target))) {
		ctx.addIssue({
			code: "custom",
			path,
			message: "target overlaps a protected runtime or kernel path",
		});
	}
	if (seenNames.has(mount.name)) {
		ctx.addIssue({
			code: "custom",
			path: ["spec", "persistence", "mounts", index, "name"],
			message: "persistence mount names must be unique",
		});
	}
	seenNames.add(mount.name);
	validateMountOverlap(mounts, mount, index, path, ctx);
	validateMemoryPathOverlap(spec, mount, path, ctx);
}

function validateMountOverlap(
	mounts: PersistenceMount[],
	mount: PersistenceMount,
	index: number,
	path: Array<string | number>,
	ctx: z.RefinementCtx,
): void {
	for (const [otherIndex, other] of mounts.entries()) {
		if (otherIndex >= index) continue;
		if (!pathContains(other.target, mount.target) && !pathContains(mount.target, other.target)) {
			continue;
		}
		ctx.addIssue({
			code: "custom",
			path,
			message: `target overlaps persistence mount ${other.name}`,
		});
	}
}

function validateMemoryPathOverlap(
	spec: TemplateSpec,
	mount: PersistenceMount,
	path: Array<string | number>,
	ctx: z.RefinementCtx,
): void {
	for (const memoryPath of spec.security.writableMemoryPaths) {
		if (!pathContains(memoryPath, mount.target) && !pathContains(mount.target, memoryPath)) {
			continue;
		}
		ctx.addIssue({
			code: "custom",
			path,
			message: `target overlaps writableMemoryPath ${memoryPath}`,
		});
	}
}

function validateSourceMount(
	spec: TemplateSpec,
	mounts: PersistenceMount[],
	ctx: z.RefinementCtx,
): void {
	if (!spec.source) return;
	const destination = mounts.find((mount) => mount.name === spec.source?.destinationMount);
	if (destination) return;
	ctx.addIssue({
		code: "custom",
		path: ["spec", "source", "destinationMount"],
		message: "source destinationMount must name a persistence mount",
	});
}

function isNormalizedFilesystemPath(path: string): boolean {
	if (!ABS_PATH_RE.test(path) || path === "/") return false;
	if (path.endsWith("/") || path.includes("//") || path.includes("\\") || path.includes(",")) {
		return false;
	}
	if (
		[...path].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127;
		})
	) {
		return false;
	}
	return !path.split("/").some((part) => part === "." || part === "..");
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

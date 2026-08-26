import type { z } from "zod";
import type { PersistenceMount } from "./persistence";
import { isAbsolutePath, SECRET_ENV_PATTERN, SECRET_REFERENCE_PREFIX } from "./template-constants";
import { agentApiHarness, isAgentApiNative, templateServices } from "./template-runtime";
import { secretMountPath, type TemplateServiceRoute, type TemplateSpec } from "./template-schema";

function envSources(spec: TemplateSpec): Array<[Array<string | number>, Record<string, string>]> {
  const sources: Array<[Array<string | number>, Record<string, string>]> = [
    [["spec", "env"], spec.env],
    [
      isAgentApiNative(spec) ? ["spec", "agent", "env"] : ["spec", "harness", "env"],
      agentApiHarness(spec).env,
    ],
  ];
  for (const [i, step] of spec.setup.entries()) {
    sources.push([["spec", "setup", i, "env"], step.env]);
  }
  if (!isAgentApiNative(spec) && spec.checkpointHook) {
    sources.push([["spec", "checkpointHook", "env"], spec.checkpointHook.env]);
  }
  if (spec.terminal) sources.push([["spec", "terminal", "env"], spec.terminal.env]);
  return sources;
}

const NETWORK_ENV = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy"]);

function validateNetworkEnvironment(spec: TemplateSpec, ctx: z.RefinementCtx): void {
  if (spec.network.mode !== "restricted") return;
  for (const [path, env] of envSources(spec)) {
    for (const key of Object.keys(env)) {
      if (!NETWORK_ENV.has(key.toLowerCase())) continue;
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: "proxy variables are reserved by restricted networking",
      });
    }
  }
}

function validateServices(spec: TemplateSpec, ctx: z.RefinementCtx): void {
  for (const [serviceName, service] of Object.entries(templateServices(spec))) {
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
        SECRET_ENV_PATTERN.test(key) && !value.startsWith(SECRET_REFERENCE_PREFIX) && value !== "";
      if (literalSecret) {
        ctx.addIssue({
          code: "custom",
          path: where,
          message: `env ${key} looks like a secret literal; use a "${SECRET_REFERENCE_PREFIX}" reference resolved by the deployment`,
        });
      }
      if (value.startsWith(SECRET_REFERENCE_PREFIX) && !validSecretReference(value)) {
        ctx.addIssue({
          code: "custom",
          path: where,
          message: `env ${key} has an invalid secret reference`,
        });
      }
    }
  }
}

function validateTerminal(spec: TemplateSpec, ctx: z.RefinementCtx): void {
  if (
    !spec.terminal?.cwd ||
    spec.terminal.cwd === "/" ||
    isNormalizedFilesystemPath(spec.terminal.cwd)
  )
    return;
  ctx.addIssue({
    code: "custom",
    path: ["spec", "terminal", "cwd"],
    message: "cwd must be a normalized absolute filesystem path",
  });
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
    if (!SECRET_ENV_PATTERN.test(name)) continue;
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
  validateAgentStateFile(spec, mounts, ctx);
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

function validateAgentStateFile(
  spec: TemplateSpec,
  mounts: PersistenceMount[],
  ctx: z.RefinementCtx,
): void {
  if (!isAgentApiNative(spec)) return;
  const stateFile = spec.agent.stateFile;
  const normalized = stateFile !== undefined && isNormalizedFilesystemPath(stateFile);
  if (stateFile !== undefined && !normalized) {
    ctx.addIssue({
      code: "custom",
      path: ["spec", "agent", "stateFile"],
      message: "stateFile must be a normalized absolute filesystem path",
    });
  }
  if (spec.agent.transport === "acp" && spec.persistence.conversationRestore === "supported") {
    ctx.addIssue({
      code: "custom",
      path: ["spec", "persistence", "conversationRestore"],
      message: "supported conversation restore requires PTY transport",
    });
    return;
  }
  if (spec.persistence.conversationRestore !== "supported") return;
  if (normalized && mounts.some((mount) => stateFile.startsWith(`${mount.target}/`))) return;
  ctx.addIssue({
    code: "custom",
    path: ["spec", "agent", "stateFile"],
    message: "supported conversation restore requires agent.stateFile below a persistence mount",
  });
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
  if (!isAbsolutePath(path) || path === "/") return false;
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

export function validateTemplateSpec(spec: TemplateSpec, ctx: z.RefinementCtx): void {
  validateServices(spec, ctx);
  validateEnvironment(spec, ctx);
  validateOutputs(spec, ctx);
  validateWritableMemoryPaths(spec, ctx);
  validatePersistence(spec, ctx);
  validateNetworkEnvironment(spec, ctx);
  validateTerminal(spec, ctx);
}

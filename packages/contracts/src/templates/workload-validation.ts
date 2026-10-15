import type { z } from "zod";
import { SECRET_ENV_PATTERN } from "./template-constants";
import { isNormalizedPath } from "./template-validation";
import type { WorkloadTemplate } from "./workload-template";

type Spec = WorkloadTemplate["spec"];
type Issue = (path: (string | number)[], message: string) => void;

function isWorkloadPath(path: string) {
  return (
    path.startsWith("/") &&
    !/[\\,\s]/.test(path) &&
    !path.includes("//") &&
    !path.endsWith("/") &&
    ![...path].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateProfile(spec: Spec, issue: Issue) {
  const operations = Object.values(spec.operations);
  if (operations.length === 0 && spec.profile !== "service")
    issue(["operations"], "at least one operation is required");
  if (spec.profile === "service" && Object.keys(spec.services).length === 0)
    issue(["services"], "service profile requires declared transport");
  if (
    spec.profile === "finite-process" &&
    (operations.length !== 1 ||
      !Object.hasOwn(spec.adapters, operations[0]?.adapter ?? "") ||
      spec.adapters[operations[0]?.adapter ?? ""]?.kind !== "process")
  ) {
    issue(["operations"], "finite-process requires one process operation");
  }
}

function validateSecurity(spec: Spec, issue: Issue) {
  if (!spec.security.readOnlyRoot || !spec.security.dropCapabilities.includes("ALL")) {
    issue(["security"], "workload profiles require a read-only root and all capabilities dropped");
  }
  for (const path of spec.security.writableMemoryPaths) {
    if (!isWorkloadPath(path) || ["/run/pocketcoder", "/proc", "/sys", "/dev"].some((root) => overlaps(path, root))) {
      issue(["security", "writableMemoryPaths"], "writable path overlaps protected storage or is not normalized");
    }
  }
}

function validateAdapters(spec: Spec, issue: Issue) {
  for (const [name, adapter] of Object.entries(spec.adapters)) {
    const path = ["adapters", name];
    if (adapter.kind === "service") {
      if (!adapter.service || !Object.hasOwn(spec.services, adapter.service) || adapter.command)
        issue(path, "service adapters require a declared service and no process command");
    } else if (!adapter.command || adapter.service) {
      issue(path, "process, Pi and AgentAPI adapters require a command and no service reference");
    }
  }
}

function validateProcessEnvironment(spec: Spec, issue: Issue) {
  const processes = [
    ...Object.entries(spec.adapters).map(([name, adapter]) => ({ path: ["adapters", name], process: adapter })),
    ...Object.entries(spec.services).flatMap(([name, service]) =>
      service.process ? [{ path: ["services", name, "process"], process: service.process }] : [],
    ),
  ];
  for (const { path, process } of processes) {
    if (process.cwd && process.cwd !== "/" && !isWorkloadPath(process.cwd)) issue(path, "cwd must be normalized");
    validateEnv(spec, process.env, path, issue);
  }
}

function validateEnv(spec: Spec, env: Record<string, string>, path: string[], issue: Issue) {
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith("credentialSlot:")) {
      if (!Object.hasOwn(spec.credentialSlots, value.slice(15)))
        issue([...path, "env", key], "unknown credential slot");
    } else if ((SECRET_ENV_PATTERN.test(key) && value !== "") || value.startsWith("secretRef:")) {
      issue([...path, "env", key], "runtime credentials require a credentialSlot: reference");
    }
    if (spec.network.mode === "restricted" && /^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)) {
      issue([...path, "env", key], "proxy variables are reserved by restricted networking");
    }
  }
}

function validateOperations(spec: Spec, issue: Issue) {
  for (const [name, operation] of Object.entries(spec.operations)) {
    const adapter = Object.hasOwn(spec.adapters, operation.adapter) ? spec.adapters[operation.adapter] : undefined;
    if (!adapter) issue(["operations", name, "adapter"], "operation must name a pinned adapter");
    if (spec.profile === "cloud-interactive" && adapter?.kind === "process")
      issue(["operations", name], "cloud-interactive requires request-aware adapters");
    for (const root of operation.outputRoots) {
      if (!isWorkloadPath(root) || ["/run", "/proc", "/sys", "/dev"].some((path) => overlaps(path, root))) {
        issue(["operations", name, "outputRoots"], "output roots must be normalized and outside protected storage");
      }
    }
  }
}

function serviceUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackService(url: URL) {
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

function validateServices(spec: Spec, issue: Issue) {
  for (const [name, service] of Object.entries(spec.services)) {
    const url = serviceUrl(service.baseUrl);
    if (!url || !isLoopbackService(url)) {
      issue(["services", name], "service must use loopback HTTP without credentials or a path");
      continue;
    }
    const routes = new Set<string>();
    if (!isNormalizedPath(service.healthPath))
      issue(["services", name, "healthPath"], "health path must be normalized");
    for (const route of service.routes) {
      const key = `${route.method} ${route.path}`;
      if (!isNormalizedPath(route.path) || routes.has(key))
        issue(["services", name, "routes"], "routes must be normalized and unique");
      routes.add(key);
    }
    for (const [previewName, preview] of Object.entries(spec.previews)) {
      if (preview.port === Number(url.port || 80))
        issue(["previews", previewName], "preview port is reserved by a service");
    }
  }
}

export function validateWorkloadTemplate(manifest: WorkloadTemplate, ctx: z.RefinementCtx) {
  const spec = manifest.spec;
  const issue: Issue = (path, message) => ctx.addIssue({ code: "custom", path: ["spec", ...path], message });
  validateProfile(spec, issue);
  validateSecurity(spec, issue);
  validateAdapters(spec, issue);
  validateProcessEnvironment(spec, issue);
  validateOperations(spec, issue);
  validateServices(spec, issue);
  for (const [name, slot] of Object.entries(spec.credentialSlots)) {
    if (slot.maxLeaseSeconds > spec.limits.deadlineSeconds)
      issue(["credentialSlots", name], "credential lifetime exceeds the workspace deadline");
  }
}

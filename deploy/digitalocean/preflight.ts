import { readFile } from "node:fs/promises";

type KubeObject = Record<string, unknown>;

function object(value: unknown): KubeObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as KubeObject)
    : null;
}

function at(value: unknown, ...keys: string[]) {
  let current = value;
  for (const key of keys) {
    const currentObject = object(current);
    if (!currentObject) return undefined;
    current = currentObject[key];
  }
  return current;
}

function parseDocuments(rendered: string, errors: string[]) {
  const documents: KubeObject[] = [];
  for (const source of rendered.split(/^---\s*$/m)) {
    if (!source.trim()) continue;
    try {
      const document = object(Bun.YAML.parse(source));
      if (document) documents.push(document);
    } catch (error) {
      errors.push(
        `invalid rendered YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return documents;
}

function named(documents: KubeObject[], kind: string, name: string) {
  return documents.find(
    (document) => document.kind === kind && at(document, "metadata", "name") === name,
  );
}

function namedContainer(resource: KubeObject | undefined, name: string) {
  const containers = at(resource, "spec", "template", "spec", "containers");
  if (!Array.isArray(containers)) return undefined;
  return containers.map(object).find((container) => container?.name === name) ?? undefined;
}

function imageError(reference: string) {
  const match = reference.match(/^[^\s@]+@sha256:([0-9a-f]{64})$/);
  if (!match) return `image ${reference} must use repo@sha256:<64 lowercase hex>`;
  const digest = match[1] ?? "";
  if (/^([0-9a-f])\1{63}$/.test(digest)) {
    return `image ${reference} uses an obvious placeholder digest`;
  }
  return null;
}

function templateImages(documents: KubeObject[], errors: string[]) {
  const configMap = named(documents, "ConfigMap", "pocketcoder-templates");
  const data = object(configMap?.data);
  if (!data) {
    errors.push("pocketcoder-templates ConfigMap is missing");
    return [];
  }
  const source = data["persistent-echo.json"];
  if (typeof source !== "string") {
    errors.push("pocketcoder-templates must contain persistent-echo.json");
    return [];
  }
  try {
    const image = at(JSON.parse(source), "spec", "image");
    if (typeof image !== "string") throw new Error("spec.image is missing");
    return [image];
  } catch (error) {
    errors.push(
      `persistent-echo.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function validateImages(documents: KubeObject[], errors: string[]) {
  const deploymentImage = namedContainer(
    named(documents, "Deployment", "pocketcoder-server"),
    "server",
  )?.image;
  const migrationImage = namedContainer(
    named(documents, "Job", "pocketcoder-migrate"),
    "migrate",
  )?.image;
  const references = [deploymentImage, migrationImage, ...templateImages(documents, errors)];
  for (const reference of references) {
    if (typeof reference !== "string") {
      errors.push("server, migration, and persistent echo images are required");
      continue;
    }
    const error = imageError(reference);
    if (error) errors.push(error);
  }
  if (
    typeof deploymentImage === "string" &&
    typeof migrationImage === "string" &&
    deploymentImage !== migrationImage
  ) {
    errors.push("the migration Job and server Deployment must use the same image digest");
  }
}

function validateStorage(documents: KubeObject[], errors: string[]) {
  const volume = named(documents, "PersistentVolume", "pocketcoder-digitalocean-nfs");
  if (!volume) {
    errors.push("pocketcoder-digitalocean-nfs PersistentVolume is missing");
  } else {
    const modes = at(volume, "spec", "accessModes");
    if (!Array.isArray(modes) || !modes.includes("ReadWriteMany")) {
      errors.push("DigitalOcean NFS PersistentVolume must use ReadWriteMany");
    }
    if (at(volume, "spec", "persistentVolumeReclaimPolicy") !== "Retain") {
      errors.push("DigitalOcean NFS PersistentVolume must use Retain");
    }
    if (at(volume, "spec", "storageClassName") !== "") {
      errors.push("DigitalOcean NFS PersistentVolume must disable dynamic provisioning");
    }
    const server = at(volume, "spec", "nfs", "server");
    const path = at(volume, "spec", "nfs", "path");
    if (typeof server !== "string" || server === "") errors.push("NFS server is required");
    if (typeof path !== "string" || !path.startsWith("/")) {
      errors.push("NFS export path must be absolute");
    }
  }
  const claim = named(documents, "PersistentVolumeClaim", "pocketcoder-workspaces");
  if (!claim) {
    errors.push("pocketcoder-workspaces PersistentVolumeClaim is missing");
    return;
  }
  const modes = at(claim, "spec", "accessModes");
  if (!Array.isArray(modes) || !modes.includes("ReadWriteMany")) {
    errors.push("pocketcoder-workspaces must use ReadWriteMany");
  }
  if (at(claim, "spec", "storageClassName") !== "") {
    errors.push("pocketcoder-workspaces must disable dynamic storage provisioning");
  }
}

function validateServiceAccounts(documents: KubeObject[], errors: string[]) {
  for (const name of ["pocketcoder-controller", "pocketcoder-workspace"]) {
    if (!named(documents, "ServiceAccount", name)) errors.push(`${name} ServiceAccount is missing`);
  }
  if (
    named(documents, "ServiceAccount", "pocketcoder-workspace")?.automountServiceAccountToken !==
    false
  ) {
    errors.push("workspace ServiceAccount must disable token automounting");
  }
  if (documents.some((document) => document.kind === "Secret")) {
    errors.push("rendered example must not contain Secret values");
  }
}

function validateServer(documents: KubeObject[], errors: string[]) {
  const deployment = named(documents, "Deployment", "pocketcoder-server");
  const server = namedContainer(deployment, "server");
  if (!deployment || !server) {
    errors.push("pocketcoder-server Deployment is missing");
    return;
  }
  if (at(deployment, "spec", "replicas") !== 1) errors.push("server replicas must equal 1");
  if (at(deployment, "spec", "strategy", "type") !== "Recreate") {
    errors.push("server strategy must be Recreate");
  }
  if (
    at(deployment, "spec", "template", "spec", "serviceAccountName") !== "pocketcoder-controller"
  ) {
    errors.push("server must use the controller ServiceAccount");
  }
  const security = at(deployment, "spec", "template", "spec", "securityContext");
  if (
    at(security, "runAsUser") !== 10_001 ||
    at(security, "runAsGroup") !== 10_001 ||
    at(security, "runAsNonRoot") !== true
  ) {
    errors.push("server must run as non-root uid/gid 10001");
  }
  if (at(server, "readinessProbe", "httpGet", "path") !== "/readyz") {
    errors.push("server readiness probe must use /readyz");
  }
  if (at(server, "livenessProbe", "httpGet", "path") !== "/livez") {
    errors.push("server liveness probe must use /livez");
  }
}

function migrationEnvironment(container: KubeObject) {
  return Array.isArray(container.env)
    ? container.env.map(object).filter((entry) => entry !== null)
    : [];
}

function validateMigration(documents: KubeObject[], errors: string[]) {
  const migration = named(documents, "Job", "pocketcoder-migrate");
  const migrationContainer = namedContainer(migration, "migrate");
  if (!migration || !migrationContainer) {
    errors.push("pocketcoder-migrate Job is missing");
    return;
  }
  if (at(migration, "spec", "template", "spec", "automountServiceAccountToken") !== false) {
    errors.push("migration Job must disable its service account token");
  }
  const migrationSecurity = at(migration, "spec", "template", "spec", "securityContext");
  if (
    at(migrationSecurity, "runAsUser") !== 10_001 ||
    at(migrationSecurity, "runAsGroup") !== 10_001 ||
    at(migrationSecurity, "runAsNonRoot") !== true
  ) {
    errors.push("migration Job must run as non-root uid/gid 10001");
  }
  if (
    JSON.stringify(migrationContainer.command) !== JSON.stringify(["pcd"]) ||
    JSON.stringify(migrationContainer.args) !== JSON.stringify(["db", "migrate"])
  ) {
    errors.push("migration Job must run pcd db migrate");
  }
  const environment = migrationEnvironment(migrationContainer);
  const environmentNames = environment
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
  if (
    JSON.stringify(environmentNames) !==
    JSON.stringify(["POCKETCODER_DATABASE_SCHEMA", "POCKETCODER_DATABASE_URL"])
  ) {
    errors.push("migration Job may receive only the database URL and schema");
  }
  const databaseUrl = environment.find((entry) => entry.name === "POCKETCODER_DATABASE_URL");
  if (
    at(databaseUrl, "valueFrom", "secretKeyRef", "name") !== "pocketcoder-server" ||
    at(databaseUrl, "valueFrom", "secretKeyRef", "key") !== "database-url"
  ) {
    errors.push("migration database URL must come from pocketcoder-server/database-url");
  }
  const volumes = at(migration, "spec", "template", "spec", "volumes");
  if (Array.isArray(volumes) && volumes.length > 0) {
    errors.push("migration Job must not mount deployment Secrets or storage");
  }
}

function validateService(documents: KubeObject[], errors: string[]) {
  const service = named(documents, "Service", "pocketcoder-server");
  if (!service) {
    errors.push("pocketcoder-server Service is missing");
    return;
  }
  const type = at(service, "spec", "type");
  if (type === "ClusterIP") return;
  if (type !== "LoadBalancer") {
    errors.push("default Service must be ClusterIP");
    return;
  }
  const annotations = object(at(service, "metadata", "annotations"));
  const certificate =
    annotations?.["service.beta.kubernetes.io/do-loadbalancer-certificate-name"] ??
    annotations?.["service.beta.kubernetes.io/do-loadbalancer-certificate-id"];
  if (typeof certificate !== "string" || certificate.includes("REPLACE_")) {
    errors.push("public Service requires a real DigitalOcean certificate name or id");
  }
  if (annotations?.["service.beta.kubernetes.io/do-loadbalancer-protocol"] !== "https") {
    errors.push("public Service must terminate HTTPS at the DigitalOcean load balancer");
  }
  const ranges = at(service, "spec", "loadBalancerSourceRanges");
  if (!Array.isArray(ranges) || ranges.length === 0) {
    errors.push("public Service requires loadBalancerSourceRanges");
  } else if (ranges.includes("0.0.0.0/0") || ranges.includes("::/0")) {
    errors.push("public Service must not use an allow-all source range");
  }
}

export function validateRenderedManifest(rendered: string) {
  const errors: string[] = [];
  const documents = parseDocuments(rendered, errors);
  if (/\bREPLACE_[A-Z0-9_]+\b/.test(rendered)) {
    errors.push("rendered manifest contains unresolved REPLACE_ placeholders");
  }
  validateImages(documents, errors);
  validateStorage(documents, errors);
  validateServiceAccounts(documents, errors);
  validateServer(documents, errors);
  validateMigration(documents, errors);
  validateService(documents, errors);
  return [...new Set(errors)];
}

async function input() {
  const paths = process.argv.slice(2);
  if (paths.length === 0 || paths[0] === "-") return new Response(Bun.stdin.stream()).text();
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n---\n");
}

if (import.meta.main) {
  const errors = validateRenderedManifest(await input());
  if (errors.length > 0) {
    for (const error of errors) console.error(`preflight: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("DigitalOcean deployment preflight passed.");
  }
}

import { readFile } from "node:fs/promises";
import { validatePiGateway } from "./preflight-gateway";
import { at, imageError, type KubeObject, named, namedContainer, object } from "./preflight-objects";

function parseDocuments(rendered: string, errors: string[]) {
  const documents: KubeObject[] = [];
  for (const source of rendered.split(/^---\s*$/m)) {
    if (!source.trim()) continue;
    try {
      const document = object(Bun.YAML.parse(source));
      if (document) documents.push(document);
    } catch (error) {
      errors.push(`invalid rendered YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return documents;
}

function templateImages(documents: KubeObject[], errors: string[]) {
  const configMap = named(documents, "ConfigMap", "pocketcoder-templates");
  const data = object(configMap?.data);
  if (!data) {
    errors.push("pocketcoder-templates ConfigMap is missing");
    return [];
  }
  const images: string[] = [];
  for (const name of ["persistent-echo.json", "pi-harness.json"]) {
    const source = data[name];
    if (typeof source !== "string") {
      errors.push(`pocketcoder-templates must contain ${name}`);
      continue;
    }
    try {
      const image = at(JSON.parse(source), "spec", "image");
      if (typeof image !== "string") throw new Error("spec.image is missing");
      images.push(image);
    } catch (error) {
      errors.push(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return images;
}

function validateImages(documents: KubeObject[], errors: string[]) {
  const deploymentImage = namedContainer(named(documents, "Deployment", "pocketcoder-server"), "server")?.image;
  const adminImage = namedContainer(named(documents, "Pod", "pocketcoder-admin"), "admin")?.image;
  if (typeof adminImage !== "string") {
    errors.push("bootstrap admin image is required");
  } else {
    const error = imageError(adminImage);
    if (error) errors.push(error);
    if (adminImage !== deploymentImage) errors.push("bootstrap admin image must match the server image");
  }
  const references = [deploymentImage, ...templateImages(documents, errors)];
  for (const reference of references) {
    if (typeof reference !== "string") {
      errors.push("server, echo, and Pi images are required");
      continue;
    }
    const error = imageError(reference);
    if (error) errors.push(error);
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
  if (named(documents, "ServiceAccount", "pocketcoder-workspace")?.automountServiceAccountToken !== false) {
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
  if (at(deployment, "spec", "template", "spec", "serviceAccountName") !== "pocketcoder-controller") {
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

function validateControllerData(documents: KubeObject[], errors: string[]) {
  const claim = named(documents, "PersistentVolumeClaim", "pocketcoder-data");
  const modes = at(claim, "spec", "accessModes");
  const storageClass = at(claim, "spec", "storageClassName");
  if (
    !Array.isArray(modes) ||
    modes.length !== 1 ||
    modes[0] !== "ReadWriteOnce" ||
    storageClass !== "do-block-storage"
  )
    errors.push("pocketcoder-data must use a block volume with ReadWriteOnce");
  const server = namedContainer(named(documents, "Deployment", "pocketcoder-server"), "server");
  const environment = Array.isArray(server?.env) ? server.env.map(object) : [];
  if (
    !environment.some(
      (entry) => entry?.name === "POCKETCODER_DIR" && entry.value === "/var/lib/pocketcoder-controller/pc_data",
    )
  )
    errors.push("server POCKETCODER_DIR must use /var/lib/pocketcoder-controller/pc_data");
  const mounts = Array.isArray(server?.volumeMounts) ? server.volumeMounts.map(object) : [];
  if (
    !mounts.some((entry) => entry?.name === "controller-data" && entry.mountPath === "/var/lib/pocketcoder-controller")
  )
    errors.push("server must mount controller-data at /var/lib/pocketcoder-controller");
  const deployment = named(documents, "Deployment", "pocketcoder-server");
  const volumes = at(deployment, "spec", "template", "spec", "volumes");
  if (
    !Array.isArray(volumes) ||
    !volumes.some(
      (entry) =>
        at(entry, "name") === "controller-data" &&
        at(entry, "persistentVolumeClaim", "claimName") === "pocketcoder-data",
    )
  )
    errors.push("controller-data must reference the pocketcoder-data claim");
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
  validateControllerData(documents, errors);
  validateService(documents, errors);
  validatePiGateway(documents, errors);
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

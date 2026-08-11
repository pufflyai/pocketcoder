import {
  at,
  imageError,
  type KubeObject,
  named,
  namedContainer,
  object,
} from "./preflight-objects";

const SESSION_SECRET = "pocketcoder-pi-gateway-session";

function environment(container: KubeObject | undefined) {
  const entries = container?.env;
  return Array.isArray(entries) ? entries.map(object).filter((entry) => entry !== null) : [];
}

function envEntry(container: KubeObject | undefined, name: string) {
  return environment(container).find((entry) => entry.name === name);
}

function validateSecretEnv(
  container: KubeObject | undefined,
  name: string,
  key: string,
  errors: string[],
) {
  const entry = envEntry(container, name);
  if (
    at(entry, "valueFrom", "secretKeyRef", "name") !== SESSION_SECRET ||
    at(entry, "valueFrom", "secretKeyRef", "key") !== key
  ) {
    errors.push(`${name} must come from ${SESSION_SECRET}/${key}`);
  }
}

function piTemplate(documents: KubeObject[], errors: string[]) {
  const source = object(named(documents, "ConfigMap", "pocketcoder-templates")?.data)?.[
    "pi-harness.json"
  ];
  if (typeof source !== "string") {
    errors.push("pocketcoder-templates must contain pi-harness.json");
    return null;
  }
  try {
    return object(JSON.parse(source));
  } catch (error) {
    errors.push(
      `pi-harness.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function validatePiTemplate(documents: KubeObject[], errors: string[]) {
  const template = piTemplate(documents, errors);
  if (!template) return undefined;
  const env = object(at(template, "spec", "agent", "env"));
  if (env?.PI_GATEWAY_URL !== "http://pocketcoder-pi-gateway:8080/v1") {
    errors.push("Pi must use the private pocketcoder-pi-gateway Service");
  }
  if (env?.PI_GATEWAY_BEARER !== `secretRef:${SESSION_SECRET}/bearer`) {
    errors.push("Pi must use the projected session bearer");
  }
  if (typeof env?.PI_GATEWAY_MODEL !== "string" || env.PI_GATEWAY_MODEL === "") {
    errors.push("Pi must declare its allowed gateway model");
  }
  return typeof env?.PI_GATEWAY_MODEL === "string" ? env.PI_GATEWAY_MODEL : undefined;
}

function validateGatewayDeployment(documents: KubeObject[], errors: string[]) {
  const serviceAccount = named(documents, "ServiceAccount", "pocketcoder-pi-gateway");
  if (serviceAccount?.automountServiceAccountToken !== false) {
    errors.push("gateway ServiceAccount must disable token automounting");
  }

  const deployment = named(documents, "Deployment", "pocketcoder-pi-gateway");
  const gateway = namedContainer(deployment, "gateway");
  if (!deployment || !gateway) {
    errors.push("pocketcoder-pi-gateway Deployment is missing");
    return undefined;
  }
  const image = gateway.image;
  if (typeof image !== "string") errors.push("gateway image is required");
  else {
    const error = imageError(image);
    if (error) errors.push(error);
  }
  if (at(deployment, "spec", "replicas") !== 1) errors.push("gateway replicas must equal 1");
  if (at(deployment, "spec", "template", "spec", "automountServiceAccountToken") !== false) {
    errors.push("gateway must disable its service account token");
  }
  if (
    at(deployment, "spec", "template", "spec", "serviceAccountName") !== "pocketcoder-pi-gateway"
  ) {
    errors.push("gateway must use its dedicated ServiceAccount");
  }
  const podSecurity = at(deployment, "spec", "template", "spec", "securityContext");
  if (
    at(podSecurity, "runAsUser") !== 10_001 ||
    at(podSecurity, "runAsGroup") !== 10_001 ||
    at(podSecurity, "runAsNonRoot") !== true
  ) {
    errors.push("gateway must run as non-root uid/gid 10001");
  }
  const containerSecurity = gateway.securityContext;
  if (
    at(containerSecurity, "allowPrivilegeEscalation") !== false ||
    at(containerSecurity, "readOnlyRootFilesystem") !== true ||
    !Array.isArray(at(containerSecurity, "capabilities", "drop")) ||
    !(at(containerSecurity, "capabilities", "drop") as unknown[]).includes("ALL")
  ) {
    errors.push("gateway container must be read-only and drop all capabilities");
  }
  validateSecretEnv(gateway, "OPENAI_API_KEY", "openai-api-key", errors);
  validateSecretEnv(gateway, "PI_GATEWAY_BEARER", "bearer", errors);
  validateSecretEnv(gateway, "PI_GATEWAY_EXPIRES_AT", "expires-at", errors);
  const allowedModel = envEntry(gateway, "PI_GATEWAY_ALLOWED_MODEL")?.value;
  return typeof allowedModel === "string" ? allowedModel : undefined;
}

function validateGatewayNetwork(documents: KubeObject[], errors: string[]) {
  const service = named(documents, "Service", "pocketcoder-pi-gateway");
  if (at(service, "spec", "type") !== "ClusterIP") {
    errors.push("gateway Service must be private ClusterIP");
  }
  if (!named(documents, "NetworkPolicy", "pocketcoder-pi-gateway")) {
    errors.push("gateway ingress NetworkPolicy is missing");
  }
}

export function validatePiGateway(documents: KubeObject[], errors: string[]) {
  const piModel = validatePiTemplate(documents, errors);
  const gatewayModel = validateGatewayDeployment(documents, errors);
  if (piModel && gatewayModel && piModel !== gatewayModel) {
    errors.push("Pi and gateway must use the same allowed model");
  }
  validateGatewayNetwork(documents, errors);
}

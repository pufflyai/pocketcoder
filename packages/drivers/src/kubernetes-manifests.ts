import type {
  RuntimeMountRef,
  RuntimeSecretRef,
  WarmRuntimeLaunch,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import {
  KUBERNETES_DIGEST_ANNOTATION,
  KUBERNETES_POOL_LABEL,
  KUBERNETES_WORKSPACE_LABEL,
} from "./kubernetes-labels";

interface ManifestOptions {
  serviceAccountName?: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  egressImage?: string;
}

function volumeForMount(mount: RuntimeMountRef, index: number) {
  const name = `persistent-${index}`;
  if (mount.source.kind === "pvc") {
    return {
      volume: { name, persistentVolumeClaim: { claimName: mount.source.claimName } },
      mount: {
        name,
        mountPath: mount.target,
        readOnly: mount.readOnly ?? false,
        ...(mount.source.subPath ? { subPath: mount.source.subPath } : {}),
      },
    };
  }
  return {
    volume: { name, hostPath: { path: mount.source.path, type: "Directory" } },
    mount: { name, mountPath: mount.target, readOnly: mount.readOnly ?? false },
  };
}

function volumeForSecret(secret: RuntimeSecretRef, index: number) {
  const name = `secret-${index}`;
  if (secret.source.kind === "kubernetes-secret") {
    return {
      volume: {
        name,
        secret: {
          secretName: secret.source.secretName,
          items: [{ key: secret.source.key, path: "value" }],
        },
      },
      mount: { name, mountPath: secret.target, subPath: "value", readOnly: true },
    };
  }
  return {
    volume: { name, hostPath: { path: secret.source.path, type: "File" } },
    mount: { name, mountPath: secret.target, readOnly: true },
  };
}

function memoryVolumes(paths: string[]) {
  return paths.map((path, index) => ({
    volume: { name: `memory-${index}`, emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
    mount: { name: `memory-${index}`, mountPath: path },
  }));
}

function egressContainer(options: ManifestOptions) {
  return {
    name: "pocketcoder-egress",
    image: options.egressImage,
    imagePullPolicy: options.imagePullPolicy,
    restartPolicy: "Always",
    securityContext: {
      runAsUser: 0,
      runAsGroup: 0,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"], add: ["NET_ADMIN", "SETUID", "SETGID"] },
    },
    startupProbe: {
      httpGet: { host: "127.0.0.1", port: 18_082, path: "/readyz" },
      periodSeconds: 1,
      failureThreshold: 30,
    },
    volumeMounts: [
      {
        name: "egress-config",
        mountPath: "/run/pocketcoder/egress.json",
        subPath: "egress.json",
        readOnly: true,
      },
    ],
  };
}

function providerInputVolume(inputSecret: string) {
  return {
    name: "provider-input",
    secret: { secretName: inputSecret, items: [{ key: "input.json", path: "input.json" }] },
  };
}

function egressVolume(egressSecret: string) {
  return {
    name: "egress-config",
    secret: { secretName: egressSecret, items: [{ key: "egress.json", path: "egress.json" }] },
  };
}

export function workspaceJobManifest(
  launch: WorkspaceLaunch,
  name: string,
  inputSecret: string,
  egressSecret: string,
  options: ManifestOptions,
) {
  const { workspace } = launch;
  const spec = workspace.templateSnapshot.spec;
  const restricted = spec.network.mode === "restricted";
  const persistent = launch.mounts.map(volumeForMount);
  const secrets = launch.secrets.map(volumeForSecret);
  const memory = memoryVolumes(spec.security.writableMemoryPaths);
  const labels = { [KUBERNETES_WORKSPACE_LABEL]: workspace.id };
  const annotations = { [KUBERNETES_DIGEST_ANNOTATION]: workspace.templateDigest };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, labels, annotations },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels, annotations },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
          securityContext: {
            fsGroup: spec.security.gid,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: spec.security.seccomp },
          },
          ...(restricted ? { initContainers: [egressContainer(options)] } : {}),
          containers: [
            {
              name: "workspace",
              image: spec.image,
              imagePullPolicy: options.imagePullPolicy,
              command: spec.command,
              env: Object.entries(spec.env)
                .filter(([, value]) => !value.startsWith("secretRef:"))
                .map(([name, value]) => ({ name, value })),
              resources: {
                requests: { cpu: spec.resources.cpu, memory: spec.resources.memory },
                limits: { cpu: spec.resources.cpu, memory: spec.resources.memory },
              },
              securityContext: {
                runAsUser: spec.security.uid,
                runAsGroup: spec.security.gid,
                runAsNonRoot: true,
                readOnlyRootFilesystem: spec.security.readOnlyRoot,
                allowPrivilegeEscalation: spec.security.allowPrivilegeEscalation,
                capabilities: { drop: spec.security.dropCapabilities },
              },
              volumeMounts: [
                {
                  name: "provider-input",
                  mountPath: "/run/pocketcoder/input",
                  subPath: "input.json",
                  readOnly: true,
                },
                ...persistent.map((item) => item.mount),
                ...secrets.map((item) => item.mount),
                ...memory.map((item) => item.mount),
              ],
            },
          ],
          volumes: [
            providerInputVolume(inputSecret),
            ...(restricted ? [egressVolume(egressSecret)] : []),
            ...persistent.map((item) => item.volume),
            ...secrets.map((item) => item.volume),
            ...memory.map((item) => item.volume),
          ],
        },
      },
    },
  };
}

export function warmJobManifest(
  launch: WarmRuntimeLaunch,
  name: string,
  inputSecret: string,
  egressSecret: string,
  options: ManifestOptions,
) {
  const spec = launch.template.spec;
  const restricted = spec.network.mode === "restricted";
  const memory = memoryVolumes(spec.security.writableMemoryPaths);
  const labels = { [KUBERNETES_POOL_LABEL]: launch.runtimeId };
  const annotations = { [KUBERNETES_DIGEST_ANNOTATION]: launch.template.digest };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, labels, annotations },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels, annotations },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
          securityContext: {
            fsGroup: spec.security.gid,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: spec.security.seccomp },
          },
          ...(restricted ? { initContainers: [egressContainer(options)] } : {}),
          containers: [
            {
              name: "workspace",
              image: spec.image,
              imagePullPolicy: options.imagePullPolicy,
              command: spec.command,
              env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
              resources: { requests: spec.resources, limits: spec.resources },
              securityContext: {
                runAsUser: spec.security.uid,
                runAsGroup: spec.security.gid,
                runAsNonRoot: true,
                readOnlyRootFilesystem: spec.security.readOnlyRoot,
                allowPrivilegeEscalation: spec.security.allowPrivilegeEscalation,
                capabilities: { drop: spec.security.dropCapabilities },
              },
              volumeMounts: [
                {
                  name: "provider-input",
                  mountPath: "/run/pocketcoder/input",
                  subPath: "input.json",
                  readOnly: true,
                },
                ...memory.map((item) => item.mount),
              ],
            },
          ],
          volumes: [
            providerInputVolume(inputSecret),
            ...(restricted ? [egressVolume(egressSecret)] : []),
            ...memory.map((item) => item.volume),
          ],
        },
      },
    },
  };
}

import type {
  RuntimeMountRef,
  RuntimeSecretRef,
  WarmRuntimeLaunch,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import { type KubernetesToleration, resourceRequirements, schedulingFields } from "./kubernetes-scheduling";

interface ManifestOptions {
  podFinalizers?: string[];
  serviceAccountName?: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  egressImage?: string;
  imagePullSecret?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: KubernetesToleration[];
}

function volumeForMount(mount: RuntimeMountRef, name: string) {
  if (mount.source.kind === "tmpfs") throw new Error("Docker disposable mounts cannot be used by Kubernetes");
  if (mount.source.kind === "empty-dir") {
    return {
      volume: { name, emptyDir: { sizeLimit: String(mount.source.maxBytes) } },
      mount: { name, mountPath: mount.target, readOnly: false },
    };
  }
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

function persistentVolumes(mounts: RuntimeMountRef[]) {
  const claims = new Map<string, string>();
  const volumes: ReturnType<typeof volumeForMount>["volume"][] = [];
  const volumeMounts = mounts.map((mount, index) => {
    const existing = mount.source.kind === "pvc" ? claims.get(mount.source.claimName) : undefined;
    const rendered = volumeForMount(mount, existing ?? `persistent-${index}`);
    if (!existing) {
      volumes.push(rendered.volume);
      if (mount.source.kind === "pvc") {
        // CSI identifies the backing volume once, so each claim needs one Pod volume.
        claims.set(mount.source.claimName, rendered.volume.name);
      }
    }
    return rendered.mount;
  });
  return { volumes, volumeMounts };
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
  const disposableBytes = launch.mounts.reduce(
    (total, mount) => total + (mount.source.kind === "empty-dir" ? mount.source.maxBytes : 0),
    0,
  );
  if (disposableBytes) {
    const value = spec.resources.ephemeralStorage;
    const bytes = value ? Number.parseInt(value, 10) * (value.endsWith("Gi") ? 1024 ** 3 : 1024 ** 2) : 0;
    if (bytes < disposableBytes) throw new Error("Source storage requires full ephemeral-storage requests and limits.");
  }
  const persistent = persistentVolumes(launch.mounts);
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
        metadata: { labels, annotations, ...(options.podFinalizers ? { finalizers: options.podFinalizers } : {}) },
        spec: {
          restartPolicy: "Never",
          ...(options.imagePullSecret ? { imagePullSecrets: [{ name: options.imagePullSecret }] } : {}),
          automountServiceAccountToken: false,
          ...schedulingFields(options),
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
              resources: resourceRequirements(spec.resources),
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
                ...persistent.volumeMounts,
                ...secrets.map((item) => item.mount),
                ...memory.map((item) => item.mount),
              ],
            },
          ],
          volumes: [
            providerInputVolume(inputSecret),
            ...(restricted ? [egressVolume(egressSecret)] : []),
            ...persistent.volumes,
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
        metadata: { labels, annotations, ...(options.podFinalizers ? { finalizers: options.podFinalizers } : {}) },
        spec: {
          restartPolicy: "Never",
          ...(options.imagePullSecret ? { imagePullSecrets: [{ name: options.imagePullSecret }] } : {}),
          automountServiceAccountToken: false,
          ...schedulingFields(options),
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
              resources: resourceRequirements(spec.resources),
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

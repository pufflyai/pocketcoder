import type { TemplateSpec } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef } from "@pstdio/pocketcoder-runtime-core";
import { resourceRequirements } from "./kubernetes-scheduling";

export function storageInitializer(
  spec: TemplateSpec,
  mounts: RuntimeMountRef[],
  imagePullPolicy: "Always" | "IfNotPresent" | "Never",
) {
  const disposable = mounts
    .map((mount, index) => ({ mount, index }))
    .filter(({ mount }) => mount.source.kind === "empty-dir" && !mount.readOnly);
  if (!disposable.length) return [];
  return [
    {
      name: "pocketcoder-storage",
      image: spec.image,
      imagePullPolicy,
      command: [
        "pocketcoder-supervisor",
        "prepare-storage",
        JSON.stringify({
          uid: spec.security.uid,
          gid: spec.security.gid,
          targets: disposable.map(({ mount }) => mount.target),
        }),
      ],
      resources: resourceRequirements({ cpu: "100m", memory: "64Mi", ephemeralStorage: "64Mi" }),
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        runAsNonRoot: false,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
      },
      volumeMounts: disposable.map(({ mount, index }) => ({ name: `persistent-${index}`, mountPath: mount.target })),
    },
  ];
}

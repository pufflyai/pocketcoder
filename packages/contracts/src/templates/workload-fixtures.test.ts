import type { WorkloadTemplate } from "./workload-template";

export const fixtureDigest = `sha256:${"a".repeat(64)}`;
export const fixtureLimits = {
  deadlineSeconds: 600,
  finalizationSeconds: 30,
  inputFileBytes: 1_048_576,
  stagedInputBytes: 8_388_608,
  inputFiles: 16,
  inFlightTransfers: 2,
  exportBytes: 4_194_304,
  exportFiles: 16,
  unreferencedInputRetentionSeconds: 600,
  exportRetentionSeconds: 900,
};

export function workloadFixture(profile: "finite-process" | "cloud-interactive" = "finite-process") {
  const interactive = profile === "cloud-interactive";
  return {
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: { name: "workload-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.test/workload@${fixtureDigest}`,
      runtime: { digest: fixtureDigest, protocol: "pocketcoder.workload/v1" },
      profile,
      adapters: {
        main: {
          kind: interactive ? "pi" : "process",
          digest: fixtureDigest,
          protocol: "fixture/v1",
          command: interactive ? ["pi"] : ["/bin/echo", "done"],
        },
      },
      operations: {
        run: {
          adapter: "main",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          requiredCapabilities: [],
          outputRoots: ["/outputs"],
        },
      },
      services: {},
      previews: {},
      credentialSlots: {},
      resources: { cpu: "1", memory: "1Gi" },
      network: { mode: "restricted", allow: [] },
      security: {},
      limits: { ...fixtureLimits },
    },
  };
}

export function installedFixture(template: WorkloadTemplate) {
  return {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    incarnationId: "container-observed-identity",
    templateDigest: fixtureDigest,
    image: template.spec.image,
    runtime: template.spec.runtime,
    storage: { identity: "fixture-volume", profile: "controller-readonly/v1" },
    capabilities: [
      "ready-without-task",
      "live-inputs",
      "immutable-inputs",
      "serial-operations",
      "retained-exports",
      "explicit-start",
      "exact-exit",
      "targeted-cancel",
      "stop-before-export",
      "request-lookup",
      "deduplicated-accept",
      "explicit-publication",
      "workspace-services",
      "revocable-preview-grants",
    ],
    adapters: Object.fromEntries(
      Object.entries(template.spec.adapters).map(([name, adapter]) => [
        name,
        {
          kind: adapter.kind,
          digest: adapter.digest,
          protocol: adapter.protocol,
          capabilities: [
            "explicit-start",
            "exact-exit",
            "targeted-cancel",
            "stop-before-export",
            "request-lookup",
            "deduplicated-accept",
            "explicit-publication",
          ],
        },
      ]),
    ),
  };
}

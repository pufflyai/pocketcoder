import { describe, expect, test } from "bun:test";
import { KubernetesDriver } from "./kubernetes";
import {
  resourceRequirements,
  schedulingFields,
  validateToleration,
} from "./kubernetes-scheduling";

describe("Kubernetes scheduling manifest fields", () => {
  test("omits scheduling fields when none are configured", () => {
    expect(schedulingFields({})).toEqual({});
  });

  test("includes configured selectors and tolerations", () => {
    const nodeSelector = { "onefin.com/workload": "agent-workspace" };
    const tolerations = [
      {
        key: "onefin.com/workload",
        operator: "Equal" as const,
        value: "agent-workspace",
        effect: "NoSchedule" as const,
      },
    ];

    expect(schedulingFields({ nodeSelector })).toEqual({ nodeSelector });
    expect(schedulingFields({ tolerations })).toEqual({ tolerations });
    expect(schedulingFields({ nodeSelector, tolerations })).toEqual({ nodeSelector, tolerations });
  });
});

describe("Kubernetes resource requirements", () => {
  test("maps CPU and memory into requests and limits", () => {
    expect(resourceRequirements({ cpu: "1", memory: "512Mi" })).toEqual({
      requests: { cpu: "1", memory: "512Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    });
  });

  test("maps ephemeral storage to the Kubernetes resource name", () => {
    expect(resourceRequirements({ cpu: "1", memory: "512Mi", ephemeralStorage: "10Gi" })).toEqual({
      requests: { cpu: "1", memory: "512Mi", "ephemeral-storage": "10Gi" },
      limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "10Gi" },
    });
  });
});

describe("Kubernetes toleration validation", () => {
  test("accepts the supported NoSchedule shapes", () => {
    expect(() =>
      validateToleration({
        key: "dedicated",
        operator: "Equal",
        value: "workspace",
        effect: "NoSchedule",
      }),
    ).not.toThrow();
    expect(() => validateToleration({ operator: "Exists", effect: "NoSchedule" })).not.toThrow();
  });

  test("rejects a value with the Exists operator", () => {
    expect(() =>
      validateToleration({ operator: "Exists", value: "workspace", effect: "NoSchedule" }),
    ).toThrow("operator Exists must not set a value");
  });

  test("rejects an empty key without the Exists operator", () => {
    expect(() => validateToleration({ operator: "Equal", effect: "NoSchedule" })).toThrow(
      "empty or omitted toleration key requires operator Exists",
    );
  });

  test("rejects unknown fields", () => {
    expect(() => validateToleration({ effect: "NoSchedule", unexpected: true } as never)).toThrow(
      "unknown toleration field: unexpected",
    );
  });

  test("rejects other effects", () => {
    expect(() => validateToleration({ effect: "NoExecute" } as never)).toThrow(
      "toleration effect must be NoSchedule",
    );
  });
});

describe("Kubernetes driver scheduling validation", () => {
  test("rejects invalid tolerations without the server config layer", () => {
    expect(
      () =>
        new KubernetesDriver({
          tolerations: [
            {
              operator: "Exists",
              value: "workspace",
              effect: "NoSchedule",
            },
          ],
        }),
    ).toThrow("operator Exists must not set a value");
  });
});

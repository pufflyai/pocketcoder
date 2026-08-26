import { describe, expect, test } from "bun:test";
import { resolveKubernetesScheduling } from "./kubernetes-scheduling-config";

describe("Kubernetes scheduling configuration", () => {
  test("defaults to no scheduling fields", () => {
    expect(resolveKubernetesScheduling({})).toEqual({});
  });

  test("parses a node selector and tolerations", () => {
    expect(
      resolveKubernetesScheduling({
        POCKETCODER_KUBERNETES_NODE_SELECTOR: JSON.stringify({
          "onefin.com/workload": "agent-workspace",
        }),
        POCKETCODER_KUBERNETES_TOLERATIONS: JSON.stringify([
          {
            key: "onefin.com/workload",
            operator: "Equal",
            value: "agent-workspace",
            effect: "NoSchedule",
          },
        ]),
      }),
    ).toEqual({
      nodeSelector: { "onefin.com/workload": "agent-workspace" },
      tolerations: [
        {
          key: "onefin.com/workload",
          operator: "Equal",
          value: "agent-workspace",
          effect: "NoSchedule",
        },
      ],
    });
  });

  test("rejects malformed JSON", () => {
    expect(() =>
      resolveKubernetesScheduling({ POCKETCODER_KUBERNETES_NODE_SELECTOR: "{" }),
    ).toThrow("POCKETCODER_KUBERNETES_NODE_SELECTOR must be valid JSON");
    expect(() => resolveKubernetesScheduling({ POCKETCODER_KUBERNETES_TOLERATIONS: "[" })).toThrow(
      "POCKETCODER_KUBERNETES_TOLERATIONS must be valid JSON",
    );
  });

  test("rejects the wrong top-level JSON shapes", () => {
    expect(() =>
      resolveKubernetesScheduling({ POCKETCODER_KUBERNETES_NODE_SELECTOR: "[]" }),
    ).toThrow("POCKETCODER_KUBERNETES_NODE_SELECTOR must be a JSON object");
    expect(() => resolveKubernetesScheduling({ POCKETCODER_KUBERNETES_TOLERATIONS: "{}" })).toThrow(
      "POCKETCODER_KUBERNETES_TOLERATIONS must be a JSON array",
    );
  });

  test("rejects non-string selector values", () => {
    expect(() =>
      resolveKubernetesScheduling({
        POCKETCODER_KUBERNETES_NODE_SELECTOR: JSON.stringify({ dedicated: true }),
      }),
    ).toThrow("POCKETCODER_KUBERNETES_NODE_SELECTOR.dedicated must be a string");
  });

  test("rejects invalid toleration field types", () => {
    expect(() =>
      resolveKubernetesScheduling({
        POCKETCODER_KUBERNETES_TOLERATIONS: JSON.stringify(["workspace"]),
      }),
    ).toThrow("POCKETCODER_KUBERNETES_TOLERATIONS[0] must be an object");
    expect(() =>
      resolveKubernetesScheduling({
        POCKETCODER_KUBERNETES_TOLERATIONS: JSON.stringify([{ key: true, effect: "NoSchedule" }]),
      }),
    ).toThrow("POCKETCODER_KUBERNETES_TOLERATIONS[0].key must be a string");
    expect(() =>
      resolveKubernetesScheduling({
        POCKETCODER_KUBERNETES_TOLERATIONS: JSON.stringify([
          { operator: "Unknown", effect: "NoSchedule" },
        ]),
      }),
    ).toThrow("POCKETCODER_KUBERNETES_TOLERATIONS[0].operator must be Exists or Equal");
  });

  test("applies every semantic toleration check", () => {
    const invalid = [
      [{ operator: "Exists", value: "workspace", effect: "NoSchedule" }, "must not set a value"],
      [{ operator: "Equal", effect: "NoSchedule" }, "requires operator Exists"],
      [{ effect: "NoSchedule", unknown: true }, "unknown toleration field"],
      [{ operator: "Exists", effect: "NoExecute" }, "effect must be NoSchedule"],
    ] as const;

    for (const [toleration, message] of invalid) {
      expect(() =>
        resolveKubernetesScheduling({
          POCKETCODER_KUBERNETES_TOLERATIONS: JSON.stringify([toleration]),
        }),
      ).toThrow(message);
    }
  });
});

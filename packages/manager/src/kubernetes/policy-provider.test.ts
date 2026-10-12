import { expect, test } from "bun:test";
import { policyProvider } from "./policy-provider";

const ready = { status: { desiredNumberScheduled: 2, numberReady: 2 } };
const cilium = (config: Record<string, string> = {}, extra: object = {}) => ({
  cilium: ready,
  ciliumConfig: { "enable-policy": "default", ...config },
  ciliumNodeConfigs: [],
  ...extra,
});

test("one ready enforcing provider is accepted", () => {
  expect(policyProvider({ calico: ready })).toBe("calico");
  expect(policyProvider(cilium())).toBe("cilium");
  expect(policyProvider(cilium({ "enable-policy": "Always", "enable-k8s-networkpolicy": "TRUE" }))).toBe("cilium");
});

test("missing, unready or competing providers are refused", () => {
  expect(() => policyProvider({})).toThrow("No NetworkPolicy enforcement");
  expect(() => policyProvider({ calico: { status: { desiredNumberScheduled: 0, numberReady: 0 } } })).toThrow(
    "not ready",
  );
  expect(() => policyProvider({ calico: { status: { desiredNumberScheduled: 2, numberReady: 1 } } })).toThrow(
    "not ready",
  );
  expect(() => policyProvider({ ...cilium(), calico: ready })).toThrow("More than one");
});

test("Cilium settings that stop enforcement are refused", () => {
  const settings: Record<string, string>[] = [
    { "enable-policy": "never" },
    { "enable-policy": "Never" },
    { "enable-policy": "sometimes" },
    { "policy-audit-mode": "true" },
    { "policy-audit-mode": "1" },
    { "enable-k8s-networkpolicy": "false" },
    { "enable-k8s-networkpolicy": "F" },
  ];
  for (const config of settings) expect(() => policyProvider(cilium(config))).toThrow();
  expect(() =>
    policyProvider(cilium({}, { ciliumNodeConfigs: [{ spec: { defaults: { "policy-audit-mode": "true" } } }] })),
  ).toThrow("CiliumNodeConfig");
  const overridden = { ...ready, spec: { template: { spec: { containers: [{ args: ["--enable-policy=never"] }] } } } };
  expect(() => policyProvider(cilium({}, { cilium: overridden }))).toThrow("arguments");
});

import { expect, test } from "bun:test";
import type { Account } from "../database/store";
import { accountNetworkPolicies } from "./network";

const account = {
  id: "0f6c3b5e-9d0a-4c61-8f3e-6b2a1c9d7e40",
  namespace: "pc-account-0f6c3b5e9d0a4c618f3e6b2a1c9d7e40",
  plan: {},
} as Account;

test("Cilium clusters also allow the controller to reach the kube-apiserver entity", () => {
  const cilium = accountNetworkPolicies(account, ["203.0.113.10"], "cilium");
  expect(cilium.find((policy) => policy.kind === "CiliumNetworkPolicy")).toEqual({
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: "controller-api",
      namespace: account.namespace,
      labels: { "pocketcoder.dev/account": account.id },
    },
    spec: {
      endpointSelector: { matchLabels: { "pocketcoder.dev/role": "controller" } },
      egress: [
        {
          toEntities: ["kube-apiserver"],
          toPorts: [
            {
              ports: [
                { port: "443", protocol: "TCP" },
                { port: "6443", protocol: "TCP" },
              ],
            },
          ],
        },
      ],
    },
  });
  const calico = accountNetworkPolicies(account, ["203.0.113.10"], "calico");
  expect(calico.map((policy) => policy.kind)).not.toContain("CiliumNetworkPolicy");
});

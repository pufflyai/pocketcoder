import type { Account } from "../database/store";
export function accountNetworkPolicies(account: Account, apiAddresses: string[]) {
  const policy = (name: string, spec: object) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: account.namespace, labels: { "pocketcoder.dev/account": account.id } },
    spec,
  });
  const dns = {
    to: [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
        podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };
  return [
    policy("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
    ...["pocketcoder.workspace", "pocketcoder.pool-runtime"].map((label, index) =>
      policy(index ? "warm-egress" : "workspace-egress", {
        podSelector: { matchExpressions: [{ key: label, operator: "Exists" }] },
        policyTypes: ["Egress"],
        egress: [
          dns,
          {
            to: [{ podSelector: { matchLabels: { "pocketcoder.dev/role": "controller" } } }],
            ports: [{ protocol: "TCP", port: 8091 }],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      }),
    ),
    policy("controller", {
      podSelector: { matchLabels: { "pocketcoder.dev/role": "controller" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: ["pocketcoder.workspace", "pocketcoder.pool-runtime"].map((key) => ({
            podSelector: { matchExpressions: [{ key, operator: "Exists" }] },
          })),
          ports: [{ protocol: "TCP", port: 8091 }],
        },
      ],
      egress: [
        dns,
        {
          to: apiAddresses.map((address) => ({ ipBlock: { cidr: `${address}/32` } })),
          ports: [
            { protocol: "TCP", port: 443 },
            { protocol: "TCP", port: 6443 },
          ],
        },
      ],
    }),
  ];
}

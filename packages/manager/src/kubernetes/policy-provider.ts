type DaemonSet = {
  status?: { desiredNumberScheduled?: number; numberReady?: number };
  spec?: { template?: { spec?: { containers?: { command?: string[]; args?: string[] }[] } } };
};
export type PolicyProvider = "calico" | "cilium";

const ENFORCEMENT_KEYS = ["enable-policy", "policy-audit-mode", "enable-k8s-networkpolicy"];
// Cilium reads booleans with Go's strconv.ParseBool.
const isTrue = (value?: string) => ["1", "t", "true"].includes(value?.toLowerCase() ?? "");
const isFalse = (value?: string) => ["0", "f", "false"].includes(value?.toLowerCase() ?? "");

// Account isolation depends on NetworkPolicy that really drops traffic, so any
// doubt about enforcement refuses provisioning instead of downgrading it.
export function policyProvider(state: {
  calico?: DaemonSet;
  cilium?: DaemonSet;
  ciliumConfig?: Record<string, string>;
  ciliumNodeConfigs?: { spec?: { defaults?: Record<string, string> } }[];
}): PolicyProvider {
  const present = (["calico", "cilium"] as const).filter((name) => state[name]);
  const [provider] = present;
  if (!provider) throw new Error("No NetworkPolicy enforcement found");
  // A migration between providers runs both, with one of them not enforcing.
  if (present.length > 1) throw new Error("More than one NetworkPolicy provider is installed");
  const status = state[provider]?.status;
  if (!status?.desiredNumberScheduled || status.numberReady !== status.desiredNumberScheduled)
    throw new Error(`${provider} is not ready`);
  if (provider === "calico") return provider;
  const config = state.ciliumConfig ?? {};
  if (!["default", "always"].includes((config["enable-policy"] ?? "default").toLowerCase()))
    throw new Error("Cilium policy enforcement is off");
  if (isTrue(config["policy-audit-mode"])) throw new Error("Cilium audit mode does not drop denied traffic");
  if (isFalse(config["enable-k8s-networkpolicy"])) throw new Error("Cilium ignores Kubernetes NetworkPolicy");
  if (
    state.ciliumNodeConfigs?.some((node) =>
      Object.keys(node.spec?.defaults ?? {}).some((key) => ENFORCEMENT_KEYS.includes(key)),
    )
  )
    throw new Error("A CiliumNodeConfig overrides policy enforcement");
  const args = (state.cilium?.spec?.template?.spec?.containers ?? []).flatMap((c) => [
    ...(c.command ?? []),
    ...(c.args ?? []),
  ]);
  if (args.some((arg) => ENFORCEMENT_KEYS.some((key) => arg.startsWith(`--${key}`))))
    throw new Error("Cilium agent arguments override policy enforcement");
  return provider;
}

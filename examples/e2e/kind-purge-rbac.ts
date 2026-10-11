import { randomUUID } from "node:crypto";
import { inventoryPurgeRbac, type PurgeTarget, removePurgeRbac } from "@pstdio/pocketcoder-manager/purge";
import { createKubernetesCluster } from "./kubernetes-cluster";

type Command = (args: string[], input?: string) => Promise<string>;
const GROUP = "rbac.authorization.k8s.io";
const name = (target: PurgeTarget) => `${target.namespace}-nodes`;

async function refuses(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(message)) throw error;
    console.log(JSON.stringify({ refusal: message }));
    return true;
  }
  throw new Error("Unsafe account RBAC cleanup was accepted");
}
function fixture(kube: Command) {
  const create = (value: unknown) => kube(["create", "-f", "-"], JSON.stringify(value));
  const metadata = (target: PurgeTarget, selected = name(target)) => ({
    name: selected,
    labels: { "pocketcoder.dev/account": target.id },
  });
  async function account() {
    const id = randomUUID();
    const target = { id, namespace: `pc-account-${id.replaceAll("-", "")}` };
    await create({ apiVersion: "v1", kind: "Namespace", metadata: metadata(target, target.namespace) });
    await create({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { ...metadata(target, "controller"), namespace: target.namespace },
    });
    return target;
  }
  const role = (target: PurgeTarget, accountId = target.id) =>
    create({
      apiVersion: `${GROUP}/v1`,
      kind: "ClusterRole",
      metadata: { ...metadata(target), labels: { "pocketcoder.dev/account": accountId } },
      rules: [{ apiGroups: [""], resources: ["nodes"], verbs: ["get"] }],
    });
  const binding = (
    target: PurgeTarget,
    options: { selected?: string; role?: string; namespace?: string; unlabelled?: boolean } = {},
  ) =>
    create({
      apiVersion: `${GROUP}/v1`,
      kind: "ClusterRoleBinding",
      metadata: options.unlabelled ? { name: options.selected ?? name(target) } : metadata(target, options.selected),
      roleRef: { apiGroup: GROUP, kind: "ClusterRole", name: options.role ?? name(target) },
      subjects: [{ kind: "ServiceAccount", name: "controller", namespace: options.namespace ?? target.namespace }],
    });
  async function setup() {
    const target = await account();
    await role(target);
    await binding(target);
    const inventory = await inventoryPurgeRbac(kube, target);
    console.log(JSON.stringify({ rbacInventory: { accountId: target.id, ...inventory } }));
    return { target, inventory };
  }
  async function object(kind: string, selected: string) {
    const output = await kube(["get", kind, selected, "--ignore-not-found", "-o", "json"]);
    return output ? JSON.parse(output) : null;
  }
  async function unchanged(target: PurgeTarget, retained: { clusterRoleUid: string; clusterRoleBindingUid: string }) {
    const [role, binding] = await Promise.all([
      object("clusterrole", name(target)),
      object("clusterrolebinding", name(target)),
    ]);
    if (role?.metadata.uid !== retained.clusterRoleUid || binding?.metadata.uid !== retained.clusterRoleBindingUid)
      throw new Error("Actual RBAC identities were changed by a refused purge");
  }
  const remove = (kind: string, selected: string) => kube(["delete", kind, selected, "--wait=true", "--timeout=30s"]);
  return { account, role, binding, setup, object, unchanged, remove };
}

async function conformance() {
  const cluster = await createKubernetesCluster();
  const interrupt = () => {
    throw new Error("Owned RBAC conformance interrupted");
  };
  process.on("SIGTERM", interrupt);
  let result: Record<string, boolean>;
  try {
    const cases = fixture(cluster.kube);
    const other = await cases.setup();
    const owned = await cases.setup();
    await removePurgeRbac(cluster.kube, owned.target, owned.inventory);
    if (
      (await cases.object("clusterrole", name(owned.target))) ||
      (await cases.object("clusterrolebinding", name(owned.target)))
    )
      throw new Error("Actual owned RBAC remains after purge");
    await removePurgeRbac(cluster.kube, owned.target, owned.inventory);
    await cluster.kube(["delete", "namespace", owned.target.namespace, "--wait=true", "--timeout=30s"]);
    await removePurgeRbac(cluster.kube, owned.target, owned.inventory);
    console.log(
      JSON.stringify({ rbacDeletion: { accountId: owned.target.id, ...owned.inventory, absenceVerified: true } }),
    );
    const missing = await cases.account();
    const missingInventoryRefused = await refuses(
      () => inventoryPurgeRbac(cluster.kube, missing),
      "inventory is missing",
    );

    const replacement = await cases.setup();
    await cases.remove("clusterrolebinding", name(replacement.target));
    await cases.binding(replacement.target);
    const bindingCurrent = await inventoryPurgeRbac(cluster.kube, replacement.target);
    if (bindingCurrent.clusterRoleBindingUid === replacement.inventory.clusterRoleBindingUid)
      throw new Error("Actual binding UID did not change");
    const bindingReplacementRefused = await refuses(
      () => removePurgeRbac(cluster.kube, replacement.target, replacement.inventory),
      "identity changed",
    );
    await cases.unchanged(replacement.target, bindingCurrent);

    const roleReplacement = await cases.setup();
    await cases.remove("clusterrole", name(roleReplacement.target));
    await cases.role(roleReplacement.target);
    const roleCurrent = await inventoryPurgeRbac(cluster.kube, roleReplacement.target);
    if (roleCurrent.clusterRoleUid === roleReplacement.inventory.clusterRoleUid)
      throw new Error("Actual role UID did not change");
    const roleReplacementRefused = await refuses(
      () => removePurgeRbac(cluster.kube, roleReplacement.target, roleReplacement.inventory),
      "identity changed",
    );
    await cases.unchanged(roleReplacement.target, roleCurrent);

    const subject = await cases.account();
    await cases.role(subject);
    await cases.binding(subject, { namespace: other.target.namespace });
    const wrongSubjectRefused = await refuses(() => inventoryPurgeRbac(cluster.kube, subject), "binding differs");
    const reference = await cases.account();
    await cases.role(reference);
    await cases.binding(reference, { role: "view" });
    const wrongRoleRefRefused = await refuses(() => inventoryPurgeRbac(cluster.kube, reference), "binding differs");
    const label = await cases.account();
    await cases.role(label, other.target.id);
    await cases.binding(label);
    const labelMismatchRefused = await refuses(() => inventoryPurgeRbac(cluster.kube, label), "ownership differs");

    const late = await cases.setup();
    const lateName = `pc-late-${randomUUID()}`;
    await cases.binding(late.target, { selected: lateName, role: "view", unlabelled: true });
    await refuses(() => inventoryPurgeRbac(cluster.kube, late.target), "late grant");
    const lateBindingRefused = await refuses(
      () => removePurgeRbac(cluster.kube, late.target, late.inventory),
      "late grant",
    );
    await cases.unchanged(late.target, late.inventory);
    if (!(await cases.object("clusterrolebinding", lateName))) throw new Error("Unretained late binding was deleted");
    await cases.remove("clusterrolebinding", lateName);
    const lateRoleName = `pc-late-${randomUUID()}`;
    await cases.binding(late.target, { selected: lateRoleName, namespace: other.target.namespace, unlabelled: true });
    const lateRoleRefRefused = await refuses(
      () => removePurgeRbac(cluster.kube, late.target, late.inventory),
      "late grant",
    );
    await cases.unchanged(late.target, late.inventory);
    if (!(await cases.object("clusterrolebinding", lateRoleName))) throw new Error("Unretained role grant was deleted");
    await cases.remove("clusterrolebinding", lateRoleName);
    await removePurgeRbac(cluster.kube, late.target, late.inventory);
    await cases.unchanged(other.target, other.inventory);
    result = {
      ownedRbacAbsent: true,
      otherAccountRbacPresent: true,
      retryVerified: true,
      missingInventoryRefused,
      bindingReplacementRefused,
      roleReplacementRefused,
      wrongSubjectRefused,
      wrongRoleRefRefused,
      lateBindingRefused,
      lateRoleRefRefused,
      labelMismatchRefused,
    };
  } finally {
    try {
      await cluster.close();
    } finally {
      process.off("SIGTERM", interrupt);
    }
  }
  console.log(JSON.stringify({ ...result, cleanup: true, scope: "RBAC only; caller runtime exit proof excluded" }));
}

if (import.meta.main && process.argv[2] === "--conformance") await conformance();

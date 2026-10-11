import { z } from "zod";
import type { PurgeTarget } from "../purge/provider-types";
import type { kube } from "./command";

const ACCOUNT = "pocketcoder.dev/account";
const GROUP = "rbac.authorization.k8s.io";
const Metadata = z.object({
  name: z.string().min(1),
  uid: z.uuid(),
  labels: z.record(z.string(), z.string()).optional(),
});
const Role = z.object({ metadata: Metadata });
const Binding = z.object({
  metadata: Metadata,
  roleRef: z.object({ apiGroup: z.string(), kind: z.string(), name: z.string() }),
  subjects: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string(),
        namespace: z.string().optional(),
        apiGroup: z.string().optional(),
      }),
    )
    .optional(),
});
const Inventory = z.strictObject({ clusterRoleUid: z.uuid(), clusterRoleBindingUid: z.uuid() });
export type PurgeRbacInventory = z.infer<typeof Inventory>;
type Command = typeof kube;

function boundTarget(target: PurgeTarget) {
  const id = z.uuid().parse(target.id);
  if (target.namespace !== `pc-account-${id.replaceAll("-", "")}`) throw new Error("Account RBAC namespace differs");
  return { id, namespace: target.namespace, name: `${target.namespace}-nodes` };
}
async function resources(command: Command, kind: string) {
  return z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(await command(["get", kind, "-o", "json"]))).items;
}
function requireBinding(binding: z.infer<typeof Binding>, target: ReturnType<typeof boundTarget>) {
  const subject = binding.subjects?.[0];
  if (
    binding.roleRef.apiGroup !== GROUP ||
    binding.roleRef.kind !== "ClusterRole" ||
    binding.roleRef.name !== target.name ||
    binding.subjects?.length !== 1 ||
    subject?.kind !== "ServiceAccount" ||
    subject.name !== "controller" ||
    subject.namespace !== target.namespace ||
    (subject.apiGroup !== undefined && subject.apiGroup !== "")
  )
    throw new Error("Account RBAC binding differs");
}
function belongs(binding: z.infer<typeof Binding>, target: ReturnType<typeof boundTarget>) {
  return (
    binding.metadata.name === target.name ||
    binding.metadata.labels?.[ACCOUNT] === target.id ||
    (binding.roleRef.kind === "ClusterRole" && binding.roleRef.name === target.name) ||
    binding.subjects?.some((subject) => subject.kind === "ServiceAccount" && subject.namespace === target.namespace)
  );
}
async function current(command: Command, input: PurgeTarget, saved?: PurgeRbacInventory) {
  const target = boundTarget(input);
  const [allRoles, allBindings] = await Promise.all([
    resources(command, "clusterroles"),
    resources(command, "clusterrolebindings"),
  ]);
  const roles = allRoles
    .map((value) => Role.parse(value))
    .filter(
      (role) =>
        role.metadata.name === target.name ||
        role.metadata.labels?.[ACCOUNT] === target.id ||
        role.metadata.uid === saved?.clusterRoleUid,
    );
  const bindings = allBindings
    .map((value) => Binding.parse(value))
    .filter((binding) => belongs(binding, target) || binding.metadata.uid === saved?.clusterRoleBindingUid);
  if (roles.length > 1 || bindings.length > 1) throw new Error("Account RBAC has a late grant");
  const role = roles[0];
  const binding = bindings[0];
  for (const entry of [role, binding])
    if (entry && (entry.metadata.name !== target.name || entry.metadata.labels?.[ACCOUNT] !== target.id))
      throw new Error("Account RBAC ownership differs");
  if (binding) requireBinding(binding, target);
  if (
    saved &&
    ((role && role.metadata.uid !== saved.clusterRoleUid) ||
      (binding && binding.metadata.uid !== saved.clusterRoleBindingUid))
  )
    throw new Error("Account RBAC identity changed");
  return { role, binding, target };
}

export async function inventoryPurgeRbac(command: Command, target: PurgeTarget) {
  const state = await current(command, target);
  if (!state.role || !state.binding) throw new Error("Account RBAC inventory is missing");
  return { clusterRoleUid: state.role.metadata.uid, clusterRoleBindingUid: state.binding.metadata.uid };
}

async function deleteExact(command: Command, resource: string, name: string, uid: string) {
  await command(
    ["delete", "--raw", `/apis/${GROUP}/v1/${resource}/${encodeURIComponent(name)}`, "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid },
      propagationPolicy: "Foreground",
    }),
  );
}
async function waitGone(
  command: Command,
  target: PurgeTarget,
  saved: PurgeRbacInventory,
  selected: "role" | "binding",
) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await current(command, target, saved);
    if (!state[selected]) return;
    if (Date.now() >= deadline) throw new Error("Account RBAC deletion is unconfirmed");
    await Bun.sleep(100);
  }
}
export async function removePurgeRbac(command: Command, target: PurgeTarget, input: PurgeRbacInventory) {
  const saved = Inventory.parse(input);
  let state = await current(command, target, saved);
  if (state.binding) {
    await deleteExact(command, "clusterrolebindings", state.target.name, saved.clusterRoleBindingUid);
    await waitGone(command, target, saved, "binding");
  }
  state = await current(command, target, saved);
  if (state.role) {
    await deleteExact(command, "clusterroles", state.target.name, saved.clusterRoleUid);
    await waitGone(command, target, saved, "role");
  }
  state = await current(command, target, saved);
  if (state.role || state.binding) throw new Error("Account RBAC remains");
  return saved;
}

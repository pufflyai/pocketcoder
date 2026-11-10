import { qualifyRef } from "@pstdio/sdk/extensions";
import type { Instance } from "./instances";

const owner = "pocketcoder.pocketcoder";
export const instancesPageRef = qualifyRef(owner, { kind: "page", id: "instances" });
export const instancePageRef = qualifyRef(owner, { kind: "page", id: "instance" });
export const instanceTarget = (projectId: string, instance: Pick<Instance, "id" | "name">) => ({
  kind: "page" as const,
  page: instancePageRef,
  resource: { type: "instance", extensionId: owner, projectId, id: instance.id, label: instance.name, icon: "server" },
});

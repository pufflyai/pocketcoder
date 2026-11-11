import { defineResourceKind, eventRef, resourceMenuSlotRef } from "@pstdio/sdk/extensions";

export const instanceKind = defineResourceKind({ id: "instance", label: "PocketCoder instance", icon: "server" });
export const machineKind = defineResourceKind({
  id: "machine",
  label: "PocketCoder machine",
  icon: "bot",
  menuSlots: [{ id: "actions", placement: "context-menu", access: "owner" }],
});
export const machineActionsSlot = resourceMenuSlotRef(machineKind.ref, "actions");
export const changed = eventRef({ extensionId: "pocketcoder.pocketcoder", id: "changed" });

import { defineResourceKind, eventRef } from "@pstdio/sdk/extensions";

export const instanceKind = defineResourceKind({ id: "instance", label: "PocketCoder instance", icon: "server" });
export const machineKind = defineResourceKind({ id: "machine", label: "PocketCoder machine", icon: "bot" });
export const changed = eventRef({ extensionId: "pocketcoder.pocketcoder", id: "changed" });

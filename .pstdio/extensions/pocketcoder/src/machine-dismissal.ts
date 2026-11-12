import type { CommandContext } from "@pstdio/sdk/extensions";

export async function dismissMachine(storage: CommandContext["storage"], instanceId: string, machineId: string) {
  const recordId = storage.records.id(`dismissed-machines:${instanceId}`);
  // Bulk actions overlap. Retry from the latest value when another dismissal wins.
  for (;;) {
    const current = await storage.records.read(recordId);
    const dismissed = (current.value ?? []) as string[];
    const result = await storage.records.commit({
      operationId: storage.ids.create(),
      edits: [
        {
          recordId,
          expectedRevision: current.revision,
          replace: [...new Set([...dismissed, machineId])],
        },
      ],
    });
    if (result.state !== "refused") return;
  }
}

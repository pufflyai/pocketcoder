import { z } from "zod";
import { InstalledWorkloadSchema } from "../templates/workload-capabilities";
import { WorkloadTemplateSnapshotSchema } from "../templates/workload-template";

export const ExecutionRuntimeSchema = z.strictObject({
  workspaceId: z.uuid(),
  callerPrincipalId: z.uuid(),
  incarnationId: z.string().min(1),
  template: WorkloadTemplateSnapshotSchema,
  producer: InstalledWorkloadSchema,
  readyAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
});

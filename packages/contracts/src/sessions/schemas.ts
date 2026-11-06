import { BudgetPolicySchema, BudgetPolicyWriteSchema } from "../budgets/policy";
import { BudgetUsageSchema, CleanupReceiptSchema } from "../budgets/usage";
import { LifetimeExtensionSchema, LifetimeReceiptSchema } from "../workspaces/lifetime";
import { ServiceReceiptSchema, ServiceStartSchema } from "../workspaces/service-control";
import { CollectionResultSchema } from "./collection";
import { ErrorSchema, RuntimeEventSchema } from "./event";
import { ExportObjectSchema, InputObjectSchema, InputReferenceSchema, InputUploadSchema } from "./files";
import { ManagedExportPageSchema, ManagedHistoryPageSchema } from "./pages";
import { ExecutionProfileSchema, SessionCreateSchema, SessionSchema } from "./profile";
import { CancelCommandSchema, CancelReceiptSchema, RequestInputSchema, RequestSchema } from "./request";
import { ManagedQueueLimitsSchema } from "./states";

export const MANAGED_CONTRACT_REVISION = "pocketcoder.managed/v1" as const;
export const managedSchemas = {
  ExecutionProfile: ExecutionProfileSchema,
  SessionCreate: SessionCreateSchema,
  Session: SessionSchema,
  InputReference: InputReferenceSchema,
  InputUpload: InputUploadSchema,
  InputObject: InputObjectSchema,
  ExportObject: ExportObjectSchema,
  CollectionResult: CollectionResultSchema,
  RequestInput: RequestInputSchema,
  Request: RequestSchema,
  CancelCommand: CancelCommandSchema,
  CancelReceipt: CancelReceiptSchema,
  RuntimeEvent: RuntimeEventSchema,
  Error: ErrorSchema,
  BudgetPolicy: BudgetPolicySchema,
  BudgetPolicyWrite: BudgetPolicyWriteSchema,
  BudgetUsage: BudgetUsageSchema,
  CleanupReceipt: CleanupReceiptSchema,
  HistoryPage: ManagedHistoryPageSchema,
  ExportPage: ManagedExportPageSchema,
  ServiceStart: ServiceStartSchema,
  ServiceReceipt: ServiceReceiptSchema,
  LifetimeExtension: LifetimeExtensionSchema,
  LifetimeReceipt: LifetimeReceiptSchema,
  QueueLimits: ManagedQueueLimitsSchema,
};

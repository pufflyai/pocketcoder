import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AccountPurgeIntentSchema = z.strictObject({
  format: z.literal("pocketcoder-account-purge/v1"),
  accountId: z.uuid(),
  operationId: z.uuid(),
  createRequestDigest: Digest,
  purgeRequestDigest: Digest,
  admittedAt: z.iso.datetime(),
});
export type AccountPurgeIntent = z.infer<typeof AccountPurgeIntentSchema>;

export const AccountPurgeCompletionSchema = z.strictObject({
  format: z.literal("pocketcoder-account-purge-completion/v1"),
  intent: AccountPurgeIntentSchema,
  completedAt: z.iso.datetime(),
});
export type AccountPurgeCompletion = z.infer<typeof AccountPurgeCompletionSchema>;

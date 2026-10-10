import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

export const JOURNAL_FORMAT = "pocketcoder-journal/v1";

const at = z.iso.datetime();

// Deletions and revocations a restore must reapply, plus the data folder allowed to write.
// Records name exact targets, so replaying an old record never touches later grants.
export const JournalEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key_revoked"), keyId: z.uuid(), at }),
  z.strictObject({ kind: z.literal("keys_revoked"), principalId: z.uuid(), keyIds: z.array(z.uuid()), at }),
  z.strictObject({ kind: z.literal("principal_disabled"), principalId: z.uuid(), keyIds: z.array(z.uuid()), at }),
  z.strictObject({ kind: z.literal("principal_enabled"), principalId: z.uuid(), at }),
  z.strictObject({
    kind: z.literal("principal_access"),
    principalId: z.uuid(),
    scopes: z.array(z.string()),
    templateNames: z.array(z.string()),
    at,
  }),
  z.strictObject({ kind: z.literal("secret_retired"), name: z.string().min(1), versionId: z.uuid(), at }),
  z.strictObject({ kind: z.literal("template_retired"), name: z.string().min(1), version: z.string().min(1), at }),
  z.strictObject({ kind: z.literal("conversation_deleted"), workspaceId: z.uuid(), at }),
  z.strictObject({ kind: z.literal("workspace_purged"), principalId: z.uuid(), workspaceId: z.uuid(), at }),
  z.strictObject({ kind: z.literal("checkpoint_deleted"), principalId: z.uuid(), checkpointId: z.uuid(), at }),
  z.strictObject({ kind: z.literal("writer_claimed"), writer: SourceWriterSchema, at }),
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;

export const JournalHeaderSchema = z.strictObject({ format: z.literal(JOURNAL_FORMAT), journalId: z.uuid() });

export const JournalRecordSchema = z.strictObject({
  sequence: z.number().int().positive(),
  previous: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  event: JournalEventSchema,
});
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

// The position a backup or restore is checked against.
export const JournalCursorSchema = z.strictObject({
  journalId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type JournalCursor = z.infer<typeof JournalCursorSchema>;

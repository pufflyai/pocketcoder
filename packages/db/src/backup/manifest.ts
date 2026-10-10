import { z } from "zod";

export const BACKUP_FORMAT = "pocketcoder-backup/v1";
export const MANIFEST_PATH = "manifest.json";
export const KEY_NAMES = ["auth-pepper", "event-signing-key", "secret-key"] as const;
export type BackupKeys = Record<(typeof KEY_NAMES)[number], Uint8Array>;

const segment = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.-]+";
// Only the database tree, the key bundle and checkpoint archives can appear in a backup.
const MEMBER_PATH = new RegExp(
  `^(?:db(?:/${segment})*|keys(?:/(?:${KEY_NAMES.join("|")}))?|checkpoints(?:/[a-f0-9-]{36}-[a-f0-9-]{36}\\.tar)?)$`,
);
const memberPath = z.string().max(4096).regex(MEMBER_PATH);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export function isBackupMemberPath(path: string) {
  return MEMBER_PATH.test(path);
}

export const BackupManifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  snapshotId: z.uuid(),
  createdAt: z.iso.datetime(),
  engine: z.strictObject({ pglite: z.string().min(1), postgres: z.string().min(1) }),
  database: z.strictObject({
    // The database log position the snapshot was taken at.
    position: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
    migrations: z.array(z.strictObject({ name: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) })),
  }),
  checkpoints: z.array(
    z.strictObject({ checkpointId: z.uuid(), transferId: z.uuid(), path: memberPath, bytes, digest }),
  ),
  members: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({ path: memberPath, type: z.literal("directory") }),
      z.strictObject({ path: memberPath, type: z.literal("file"), bytes, digest }),
    ]),
  ),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export type BackupMember = BackupManifest["members"][number];

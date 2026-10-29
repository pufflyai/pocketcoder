import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrincipalGrantsSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const kubernetesName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);

// Where the controller writes a token or the admission map. Never the token itself.
export const SecretTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: z.string().startsWith("/") }),
  z.strictObject({
    kind: z.literal("kubernetes-secret"),
    namespace: kubernetesName,
    name: kubernetesName,
    key: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/),
  }),
]);
export type SecretTarget = z.infer<typeof SecretTargetSchema>;

const ManagedKeySchema = z
  .strictObject({
    lifetime_hours: z.number().int().min(2).max(8784).default(720),
    renew_before_hours: z.number().int().min(1).default(240),
    overlap_minutes: z.number().int().min(0).max(10_080).default(60),
    target: SecretTargetSchema,
  })
  .refine((key) => key.renew_before_hours < key.lifetime_hours, {
    message: "renew_before_hours must be shorter than lifetime_hours",
  });

const ManagedPrincipalSchema = PrincipalGrantsSchema.extend({
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((name) => name !== "owner", { message: "owner is reserved for the bootstrap owner" }),
  // Owner authority stays with the local admin socket; a written file must never hold it.
  scopes: PrincipalGrantsSchema.shape.scopes.refine((scopes) => !scopes.includes("admin"), {
    message: "managed principals cannot hold admin",
  }),
  admission_template: z.string().min(1).max(128).optional(),
  key: ManagedKeySchema.optional(),
});

export const PrincipalFileSchema = z
  .strictObject({
    principals: z.array(ManagedPrincipalSchema).max(1000),
    admission_map: SecretTargetSchema.optional(),
  })
  .refine((file) => new Set(file.principals.map((principal) => principal.name)).size === file.principals.length, {
    message: "principal names must be unique",
  });
export type PrincipalFile = z.infer<typeof PrincipalFileSchema>;
export type ManagedPrincipal = PrincipalFile["principals"][number];
export type ManagedKey = NonNullable<ManagedPrincipal["key"]>;

const NAMESPACE = "6f1c5bd2-8f3e-4d55-9a8c-6b0e3c2a7d41";

// UUID version 5 (RFC 9562) of the name. Every environment derives the same ID, and the
// ID marks the principal as managed, so no extra column is needed.
export function managedPrincipalId(name: string) {
  const hash = createHash("sha1")
    .update(Buffer.from(NAMESPACE.replaceAll("-", ""), "hex"))
    .update(name)
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parsePrincipalFile(text: string) {
  const parsed = PrincipalFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`invalid principal file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function readPrincipalFile(path: string) {
  return parsePrincipalFile(await readFile(path, "utf8"));
}

export function admissionMap(file: PrincipalFile) {
  return {
    principals: file.principals
      .filter((principal) => principal.admission_template)
      .map((principal) => ({
        id: managedPrincipalId(principal.name),
        name: principal.name,
        admission_template: principal.admission_template as string,
      })),
  };
}

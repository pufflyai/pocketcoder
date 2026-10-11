import { randomUUID } from "node:crypto";
import { HttpsOriginSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { ManagerError } from "./accounts/errors";
import { checkPublicViews } from "./kubernetes/public-hosts";

const KubernetesName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const PublicHostsSchema = z.strictObject({
  apiOrigin: HttpsOriginSchema,
  viewOrigin: HttpsOriginSchema,
  issuer: KubernetesName,
  ingressClassName: KubernetesName,
  ingressNamespace: KubernetesName,
  trustedIngress: z.array(z.string()).min(1).max(32),
});
export const ManagerConfigSchema = z
  .object({
    controllerImage: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
    runtimeClassName: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/),
    storageClassName: z.string().min(1).optional(),
    offNodeBackups: z.boolean().optional(),
    purgeAuthority: z.boolean().optional(),
    publicHosts: PublicHostsSchema.refine((hosts) => {
      try {
        checkPublicViews(randomUUID(), { ...hosts, parents: [] });
        return true;
      } catch {
        return false;
      }
    }, "Public hosts need separate registrable API and view domains.").optional(),
  })
  .strict();
export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;
export type PublicHosts = z.infer<typeof PublicHostsSchema> & { parents: string[] };
export type AccountPlan = Omit<ManagerConfig, "publicHosts"> & { publicHosts?: PublicHosts };
export const AccountInputSchema = z
  .object({ name: z.string().min(1).max(80), parents: z.array(HttpsOriginSchema).min(1).max(32).optional() })
  .strict();
export type AccountInput = z.infer<typeof AccountInputSchema>;

export function accountPlan(config: ManagerConfig, input: AccountInput): AccountPlan {
  const { publicHosts, ...plan } = config;
  if (!publicHosts) {
    if (input.parents) throw new ManagerError(400, "invalid_public_hosts");
    return plan;
  }
  const hosts = { ...publicHosts, parents: input.parents ?? [] };
  try {
    // Prefixing an account label does not change which registrable domains are separate.
    checkPublicViews(randomUUID(), hosts);
  } catch {
    throw new ManagerError(400, "invalid_public_hosts");
  }
  return { ...plan, publicHosts: hosts };
}
export const BootstrapInputSchema = z
  .object({
    request_id: z.uuid(),
    expires_at: z.iso.datetime(),
    replaces_request_id: z.uuid().optional(),
  })
  .strict();

import { isIP } from "node:net";
import { HttpsOriginSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { registrableDomain } from "./domains/registrable-domain";

const schema = z.strictObject({
  apiOrigin: HttpsOriginSchema,
  origin: HttpsOriginSchema,
  parents: z.array(HttpsOriginSchema).max(32).default([]),
  trustedIngress: z
    .array(z.string().refine((value) => isIP(value) !== 0))
    .max(32)
    .default([]),
});
export type PublicViewConfig = z.infer<typeof schema>;

export function publicViewConfig(raw: string | undefined) {
  if (!raw) return undefined;
  const config = schema.parse(JSON.parse(raw));
  const domain = (origin: string) => registrableDomain(new URL(origin).hostname);
  const views = domain(config.origin);
  const api = domain(config.apiOrigin);
  if (!views || !api || views === api || new URL(config.origin).hostname.endsWith(".localhost"))
    throw new Error("API and public views require different registrable HTTPS domains.");
  for (const parent of config.parents)
    if (!domain(parent) || domain(parent) === views)
      throw new Error("Embedded parents must use a different registrable domain from public views.");
  return config;
}

import { z } from "zod";

export const IssuerUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  const local = url.protocol === "http:" && url.hostname.endsWith(".svc.cluster.local");
  return (url.protocol === "https:" || local) && !url.username && !url.password && !url.search && !url.hash;
});
export const SessionIssuerSchema = z.strictObject({
  url: IssuerUrlSchema,
  tokenFile: z.string().startsWith("/"),
  policy: z.record(z.string(), z.json()).default({}),
  revoke: z.boolean().default(false),
});
export type SessionIssuer = z.infer<typeof SessionIssuerSchema>;

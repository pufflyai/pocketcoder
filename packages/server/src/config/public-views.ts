import { BlockList, isIP } from "node:net";
import { HttpsOriginSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { registrableDomain } from "./domains/registrable-domain";

// Kubernetes ingress pods change address. A cluster may trust its pod range only
// when network policy admits nothing but the ingress to the controller listener.
const ingressEntry = z.string().refine((value) => {
  const [address = "", prefix, ...rest] = value.split("/");
  const family = isIP(address);
  if (!family || rest.length) return false;
  if (prefix !== undefined && !(/^[1-9][0-9]{0,2}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
    return false;
  // Build the entry now: an address the list cannot hold must fail here, not at controller start.
  try {
    trustedIngress([value]);
    return true;
  } catch {
    return false;
  }
});

const schema = z.strictObject({
  apiOrigin: HttpsOriginSchema,
  origin: HttpsOriginSchema,
  parents: z.array(HttpsOriginSchema).max(32).default([]),
  trustedIngress: z.array(ingressEntry).max(32).default([]),
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

export function trustedIngress(entries: string[]) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    if (prefix) list.addSubnet(address, Number(prefix), family);
    else list.addAddress(address, family);
  }
  return (peer: string) => list.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6");
}

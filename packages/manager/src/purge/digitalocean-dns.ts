import { z } from "zod";
import { type DigitalOceanApi, digitalOceanPages, pending } from "./digitalocean-api";
import type { DnsRecord } from "./provider-types";

const DomainRecord = z.object({ id: z.number().int().positive(), type: z.string().min(1), name: z.string().min(1) });

// Account hosts are `LABEL.BASE` or `*.LABEL.BASE`. Any DigitalOcean domain that is BASE or one of
// its parents could hold their records, including a delegated sub-zone such as `embed.kaset.dev`.
export function digitalOceanZoneCandidates(label: string, hosts: string[]) {
  return hosts.map((host) => {
    const labels = host.split(".");
    if (labels[0] === "*") labels.shift();
    if (labels.shift() !== label) throw pending("public host is outside the account");
    const zones = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
    if (!zones.length) throw pending("public host has no parent domain");
    return zones;
  });
}

// external-dns names its ownership TXT records `a-LABEL…` and `a-wildcard.LABEL…`, and cert-manager
// adds `_acme-challenge.LABEL…` while it validates. Matching the unique account label covers them all.
export function digitalOceanAccountRecords(zone: string, pages: unknown[], label: string): DnsRecord[] {
  return digitalOceanPages(pages, "domain_records", DomainRecord)
    .filter((record) => record.name.toLowerCase().includes(label))
    .map(({ id, type, name }) => ({ zone, id, type, name }));
}

export function digitalOceanDns(api: DigitalOceanApi) {
  async function dnsRecords(label: string, hosts: string[]) {
    const zones = new Map<string, DnsRecord[] | null>();
    for (const candidates of digitalOceanZoneCandidates(label, hosts)) {
      for (const zone of candidates) {
        if (zones.has(zone)) continue;
        const pages = await api.pages(`/v2/domains/${encodeURIComponent(zone)}/records`);
        zones.set(zone, pages && digitalOceanAccountRecords(zone, pages, label));
      }
      if (candidates.every((zone) => zones.get(zone) === null)) throw pending("no domain holds a public host");
    }
    return [...zones.values()].flatMap((records) => records ?? []);
  }
  return {
    dnsRecords,
    async dnsAbsent(label: string, hosts: string[], retained: DnsRecord[]) {
      // Offset paging can skip a record while others are deleted, so check retained IDs directly too.
      for (const record of retained) {
        const path = `/v2/domains/${encodeURIComponent(record.zone)}/records/${record.id}`;
        if (await api.request(api.endpoint(path), "GET")) throw pending("retained DNS record remains");
      }
      if ((await dnsRecords(label, hosts)).length) throw pending("account DNS record remains");
      api.lifetime();
    },
  };
}

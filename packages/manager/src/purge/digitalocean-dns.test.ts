import { expect, test } from "bun:test";
import { digitalOceanAccountRecords, digitalOceanZoneCandidates } from "./digitalocean-dns";

const label = "0f6c3b5e9d0a4c618f3e6b2a1c9d7e40";
const other = "82a48a18873f11e696bf000f53315a41";
const hosts = [`${label}.pocketcoder.datazine.app`, `*.${label}.embed.kaset.dev`];
// Record fields from the official "List All Domain Records" example.
const record = (id: number, type: string, name: string, data: string) => ({
  id,
  type,
  name,
  data,
  priority: null,
  port: null,
  ttl: 1800,
  weight: null,
  flags: null,
  tag: null,
});
const official = [
  record(28448429, "NS", "@", "ns1.digitalocean.com"),
  record(28448430, "NS", "@", "ns2.digitalocean.com"),
  record(28448431, "NS", "@", "ns3.digitalocean.com"),
  record(28448432, "A", "@", "1.2.3.4"),
];
const owner = `"heritage=external-dns,external-dns/owner=pocketcoder-ams3-1,external-dns/resource=ingress/pc-account-${label}/public-hosts"`;

test("public host zones are every DigitalOcean domain above the account label", () => {
  expect(digitalOceanZoneCandidates(label, hosts)).toEqual([
    ["pocketcoder.datazine.app", "datazine.app"],
    ["embed.kaset.dev", "kaset.dev"],
  ]);
  for (const host of [
    `other.pocketcoder.datazine.app`,
    `x${label}.pocketcoder.datazine.app`,
    `${other}.pocketcoder.datazine.app`,
    `*.${other}.embed.kaset.dev`,
    `*.*.${label}.embed.kaset.dev`,
    `${label}.app`,
  ])
    expect(() => digitalOceanZoneCandidates(label, [host])).toThrow("pending");
});

test("account records include external-dns ownership names and leave other accounts alone", () => {
  const api = [
    ...official,
    record(41, "A", `${label}.pocketcoder`, "203.0.113.10"),
    record(42, "TXT", `a-${label}.pocketcoder`, owner),
    record(43, "TXT", `_acme-challenge.${label}.pocketcoder`, "challenge"),
    record(44, "A", `${other}.pocketcoder`, "203.0.113.10"),
    record(45, "TXT", `a-${other}.pocketcoder`, owner.replaceAll(label, other)),
  ];
  expect(
    digitalOceanAccountRecords("datazine.app", [{ domain_records: api, links: {}, meta: { total: 9 } }], label),
  ).toEqual([
    { zone: "datazine.app", id: 41, type: "A", name: `${label}.pocketcoder` },
    { zone: "datazine.app", id: 42, type: "TXT", name: `a-${label}.pocketcoder` },
    { zone: "datazine.app", id: 43, type: "TXT", name: `_acme-challenge.${label}.pocketcoder` },
  ]);
  const views = [
    {
      domain_records: [...official, record(51, "A", `*.${label}.embed`, "203.0.113.10")],
      meta: { total: 6 },
      links: { pages: { next: "https://api.digitalocean.com/v2/domains/kaset.dev/records?page=2" } },
    },
    { domain_records: [record(52, "TXT", `A-WILDCARD.${label.toUpperCase()}.EMBED`, owner)], meta: { total: 6 } },
  ];
  expect(digitalOceanAccountRecords("kaset.dev", views, label).map((item) => item.id)).toEqual([51, 52]);
  expect(digitalOceanAccountRecords("kaset.dev", [{ domain_records: official, meta: { total: 4 } }], label)).toEqual(
    [],
  );
});

test("account records need complete paging and stable provider IDs", () => {
  const first = {
    domain_records: [record(41, "A", `${label}.pocketcoder`, "203.0.113.10")],
    meta: { total: 2 },
    links: { pages: { next: "https://api.digitalocean.com/v2/domains/datazine.app/records?page=2" } },
  };
  expect(() => digitalOceanAccountRecords("datazine.app", [first], label)).toThrow("pending");
  expect(() => digitalOceanAccountRecords("datazine.app", [], label)).toThrow("pending");
  expect(() =>
    digitalOceanAccountRecords(
      "datazine.app",
      [first, { domain_records: [record(41, "TXT", `a-${label}.pocketcoder`, owner)], meta: { total: 2 } }],
      label,
    ),
  ).toThrow("pending");
  expect(() => digitalOceanAccountRecords("datazine.app", [{ records: [], meta: { total: 0 } }], label)).toThrow();
});

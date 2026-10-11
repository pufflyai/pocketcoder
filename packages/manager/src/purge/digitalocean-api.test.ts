import { expect, test } from "bun:test";
import { digitalOceanNextPage } from "./digitalocean-api";

test("next links preserve the exact inventory scope without forwarding credentials to another host", () => {
  const current = new URL("https://api.digitalocean.com/v2/snapshots?resource_type=volume&per_page=200&page=1");
  expect(digitalOceanNextPage("https://api.digitalocean.com/v2/snapshots?page=2", current)?.href).toBe(
    "https://api.digitalocean.com/v2/snapshots?resource_type=volume&per_page=200&page=2",
  );
  expect(digitalOceanNextPage(undefined, current)).toBeNull();
  for (const next of [
    "https://elsewhere.example/v2/snapshots?page=2",
    "http://api.digitalocean.com/v2/snapshots?page=2",
    "https://user@api.digitalocean.com/v2/snapshots?page=2",
    "https://api.digitalocean.com/v2/volumes?page=2",
    "https://api.digitalocean.com/v2/snapshots?page=1",
    "https://api.digitalocean.com/v2/snapshots?page=3",
    "https://api.digitalocean.com/v2/snapshots?page=2&resource_type=droplet",
    "https://api.digitalocean.com/v2/snapshots?page=2&per_page=1",
    "https://api.digitalocean.com/v2/snapshots?page=2&name=other",
    "https://api.digitalocean.com/v2/snapshots?page=2&page=3",
  ])
    expect(() => digitalOceanNextPage(next, current)).toThrow();
});

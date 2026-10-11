import { expect, test } from "bun:test";
import { publicViewConfig } from "./public-views";

test("public views require different registrable domains, including private suffixes", () => {
  const config = {
    apiOrigin: "https://api.service.co.uk",
    origin: "https://views.other.co.uk",
    parents: [],
    trustedIngress: [],
  };
  expect(publicViewConfig(JSON.stringify(config))?.origin).toBe(config.origin);
  expect(() => publicViewConfig(JSON.stringify({ ...config, origin: "https://views.service.co.uk" }))).toThrow();
  expect(() =>
    publicViewConfig(
      JSON.stringify({
        ...config,
        apiOrigin: "https://api.tenant.github.io",
        origin: "https://views.tenant.github.io",
      }),
    ),
  ).toThrow();
  expect(() => publicViewConfig(JSON.stringify({ ...config, origin: "https://localhost" }))).toThrow();
  expect(() => publicViewConfig(JSON.stringify({ ...config, trustedIngress: ["0.0.0.0/0"] }))).toThrow();
});

test("trusted ingress accepts addresses and bounded ranges only", () => {
  const config = { apiOrigin: "https://api.example.org", origin: "https://views.example.net" };
  const parsed = publicViewConfig(
    JSON.stringify({ ...config, trustedIngress: ["10.244.0.0/16", "fd00::/64", "127.0.0.1"] }),
  );
  expect(parsed?.trustedIngress).toEqual(["10.244.0.0/16", "fd00::/64", "127.0.0.1"]);
  for (const entry of [
    "::/0",
    "10.0.0.0/33",
    "10.0.0.0/",
    "10.0.0.0/8/8",
    "10.0.0.0/08",
    "ingress.local/16",
    "fe80::1%eth0",
  ])
    expect(() => publicViewConfig(JSON.stringify({ ...config, trustedIngress: [entry] }))).toThrow();
});

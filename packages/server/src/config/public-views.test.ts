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

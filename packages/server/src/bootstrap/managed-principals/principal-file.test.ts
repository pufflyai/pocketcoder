import { expect, test } from "bun:test";
import { admissionMap, managedPrincipalId, parsePrincipalFile } from "./principal-file";

const backend = {
  name: "backend",
  scopes: ["workspaces:read"],
  templates: ["echo"],
  admission_template: "standard",
  key: { target: { kind: "file", path: "/run/keys/backend" } },
};

test("managed principal IDs are stable UUIDs derived from the name", () => {
  const id = managedPrincipalId("backend");
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(managedPrincipalId("backend")).toBe(id);
  expect(managedPrincipalId("frontend")).not.toBe(id);
});

test("the principal file fills key defaults and rejects owner authority", () => {
  const file = parsePrincipalFile(JSON.stringify({ principals: [backend] }));
  expect(file.principals[0]?.key).toMatchObject({ lifetime_hours: 720, renew_before_hours: 240, overlap_minutes: 60 });
  for (const principal of [
    { ...backend, scopes: ["admin"] },
    { ...backend, name: "owner" },
    { ...backend, key: { ...backend.key, lifetime_hours: 24, renew_before_hours: 24 } },
    { ...backend, key: { target: { kind: "file", path: "relative/path" } } },
    { ...backend, key: { target: { kind: "file", path: "/run/keys/backend" }, token: "pkt_x" } },
  ]) {
    expect(() => parsePrincipalFile(JSON.stringify({ principals: [principal] }))).toThrow("invalid principal file");
  }
  expect(() => parsePrincipalFile(JSON.stringify({ principals: [backend, backend] }))).toThrow("unique");
});

test("the admission map comes from the same file and needs no controller", () => {
  const file = parsePrincipalFile(
    JSON.stringify({ principals: [backend, { name: "batch", scopes: ["workspaces:read"], templates: [] }] }),
  );
  expect(admissionMap(file)).toEqual({
    principals: [{ id: managedPrincipalId("backend"), name: "backend", admission_template: "standard" }],
  });
});

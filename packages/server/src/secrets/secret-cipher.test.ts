import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { openSecret, type SecretIdentity, sealSecret } from "./secret-cipher";

const identity = (type: SecretIdentity["type"]): SecretIdentity => ({
  id: randomUUID(),
  name: "operator-config",
  type,
});

test("encrypted registry values open with their authenticated metadata", () => {
  const key = randomBytes(32);
  const metadata = identity("registry");
  const value = JSON.stringify({ password: "private configuration — é" });
  const sealed = sealSecret(key, metadata, value);
  expect(openSecret(key, metadata, sealed, "registry")).toBe(value);
  expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(value))).toBe(false);
});

test("every secret write uses a fresh nonce, including identical values", () => {
  const key = randomBytes(32);
  const metadata = identity("registry");
  const first = sealSecret(key, metadata, "private configuration");
  const second = sealSecret(key, metadata, "private configuration");
  expect(first.nonce).toHaveLength(12);
  expect(first.tag).toHaveLength(16);
  expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
  expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
});

test("the original controller key is required to open a stored secret", () => {
  const metadata = identity("registry");
  const sealed = sealSecret(randomBytes(32), metadata, "private issuer configuration");
  expect(() => openSecret(randomBytes(32), metadata, sealed, "registry")).toThrow("authentication failed");
});

test.each(["name", "type", "id"] as const)("authenticated secret metadata binds %s", (field) => {
  const key = randomBytes(32);
  const metadata = identity("registry");
  const sealed = sealSecret(key, metadata, "private registry configuration");
  const changed = { ...metadata };
  if (field === "name") changed.name = "another-config";
  else if (field === "type") changed.type = "invalid" as typeof changed.type;
  else changed.id = randomUUID();
  expect(() => openSecret(key, changed, sealed, changed.type)).toThrow("authentication failed");
});

test.each(["nonce", "ciphertext", "tag"] as const)("altered secret %s cannot be opened", (field) => {
  const key = randomBytes(32);
  const metadata = identity("registry");
  const sealed = sealSecret(key, metadata, "private setup configuration");
  const bytes = Buffer.from(sealed[field]);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  expect(() => openSecret(key, metadata, { ...sealed, [field]: bytes }, "registry")).toThrow("authentication failed");
});

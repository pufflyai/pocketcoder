import { describe, expect, test } from "bun:test";
import {
  digestOpaque,
  generateOpaqueSecret,
  issueEgressAuditToken,
  issueMachineKey,
  parseMachineKey,
  redact,
  signEvent,
  verifyEgressAuditToken,
  verifyEventSignature,
  verifyOpaque,
  verifySecret,
} from "./index";

test("egress audit tokens are scoped, expiring, and tamper evident", () => {
  const token = issueEgressAuditToken("audit-key", {
    kind: "workspace",
    id: "018f5f8a-642d-7c4d-bd3a-076c6bce14d0",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  expect(verifyEgressAuditToken("audit-key", token, new Date("2029-01-01"))).toEqual({
    kind: "workspace",
    id: "018f5f8a-642d-7c4d-bd3a-076c6bce14d0",
  });
  expect(verifyEgressAuditToken("other-key", token, new Date("2029-01-01"))).toBeNull();
  expect(verifyEgressAuditToken("audit-key", token, new Date("2030-01-01"))).toBeNull();
});

const PEPPER = "test-pepper";

describe("machine keys", () => {
  test("issue, parse, and verify roundtrip", () => {
    const issued = issueMachineKey(PEPPER);
    expect(issued.token.startsWith("pkt_")).toBe(true);
    const parsed = parseMachineKey(issued.token);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(issued.id);
    if (!parsed) throw new Error("issued key did not parse");
    expect(verifySecret(PEPPER, parsed.id, parsed.secret, issued.secretDigest)).toBe(true);
  });

  test("tampered secrets and wrong peppers fail", () => {
    const issued = issueMachineKey(PEPPER);
    const parsed = parseMachineKey(issued.token);
    if (!parsed) throw new Error("issued key did not parse");
    expect(verifySecret(PEPPER, parsed.id, `${parsed.secret}x`, issued.secretDigest)).toBe(false);
    expect(verifySecret("other-pepper", parsed.id, parsed.secret, issued.secretDigest)).toBe(false);
  });

  test("malformed tokens do not parse", () => {
    expect(parseMachineKey("nope")).toBeNull();
    expect(parseMachineKey("pkt_only-two")).toBeNull();
    expect(parseMachineKey("pkt_notauuid_secret")).toBeNull();
    expect(parseMachineKey("")).toBeNull();
  });
});

describe("opaque secrets", () => {
  test("registration secret verification", () => {
    const secret = generateOpaqueSecret();
    const digest = digestOpaque(PEPPER, secret);
    expect(verifyOpaque(PEPPER, secret, digest)).toBe(true);
    expect(verifyOpaque(PEPPER, generateOpaqueSecret(), digest)).toBe(false);
  });
});

describe("event signing", () => {
  test("signature verifies and rejects tampering", () => {
    const body = JSON.stringify({ hello: "world" });
    const ts = "2026-07-29T12:00:00Z";
    const sig = signEvent("signing-key", ts, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyEventSignature("signing-key", ts, body, sig)).toBe(true);
    expect(verifyEventSignature("signing-key", ts, `${body} `, sig)).toBe(false);
    expect(verifyEventSignature("other-key", ts, body, sig)).toBe(false);
  });
});

describe("redaction", () => {
  test("machine keys and bearer headers never survive", () => {
    const issued = issueMachineKey(PEPPER);
    expect(redact(`token=${issued.token}`)).not.toContain(issued.token);
    expect(redact("Authorization: Bearer abc123")).not.toContain("abc123");
  });
});

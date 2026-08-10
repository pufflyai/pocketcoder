import { describe, expect, test } from "bun:test";
import {
  findNetworkRule,
  isPrivateAddress,
  NetworkEventBatchSchema,
  NetworkPolicySchema,
} from "./network";

describe("network policy", () => {
  test("normalizes unrestricted and restricted policies", () => {
    expect(NetworkPolicySchema.parse(undefined)).toEqual({ mode: "unrestricted" });
    expect(NetworkPolicySchema.parse({ mode: "restricted", allow: [] })).toEqual({
      mode: "restricted",
      allow: [],
    });
    expect(
      NetworkPolicySchema.parse({ mode: "restricted", allow: [{ domain: "github.com" }] }),
    ).toEqual({
      mode: "restricted",
      allow: [{ domain: "github.com", ports: [80, 443], allowPrivate: false }],
    });
  });

  test("uses exact and leading-wildcard domain matching", () => {
    const policy = NetworkPolicySchema.parse({
      mode: "restricted",
      allow: [
        { domain: "github.com", ports: [443] },
        { domain: "*.example.com", ports: [8443], allowPrivate: true },
      ],
    });
    expect(findNetworkRule(policy, "github.com", 443)?.domain).toBe("github.com");
    expect(findNetworkRule(policy, "api.github.com", 443)).toBeNull();
    expect(findNetworkRule(policy, "api.example.com", 8443)?.domain).toBe("*.example.com");
    expect(findNetworkRule(policy, "example.com", 8443)).toBeNull();
    expect(findNetworkRule(policy, "api.example.com", 443)).toBeNull();
  });

  test("rejects ambiguous domains and ports", () => {
    for (const domain of [
      "Example.com",
      "127.0.0.1",
      "*example.com",
      "api.*.com",
      "example.com.",
    ]) {
      expect(() =>
        NetworkPolicySchema.parse({ mode: "restricted", allow: [{ domain }] }),
      ).toThrow();
    }
    expect(() =>
      NetworkPolicySchema.parse({
        mode: "restricted",
        allow: [{ domain: "example.com", ports: [443, 443] }],
      }),
    ).toThrow();
  });

  test("recognizes private and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "240.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fec0::1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("network audit batches", () => {
  test("bounds events and strips the contract down to metadata", () => {
    const event = {
      source_seq: 1,
      occurred_at: new Date().toISOString(),
      decision: "allow",
      transport: "https",
      host: "api.example.com",
      port: 443,
      method: "CONNECT",
      path: null,
      matched_rule: "domain=api.example.com ports=443",
      reason: "matched_rule",
    };
    const parsed = NetworkEventBatchSchema.parse({
      source_session_id: crypto.randomUUID(),
      events: [event],
    });
    expect(parsed.events).toHaveLength(1);
    expect(() =>
      NetworkEventBatchSchema.parse({
        source_session_id: crypto.randomUUID(),
        events: Array.from({ length: 101 }, () => event),
      }),
    ).toThrow();
    expect(() =>
      NetworkEventBatchSchema.parse({
        source_session_id: crypto.randomUUID(),
        events: [{ ...event, path: "/safe?credential=forbidden" }],
      }),
    ).toThrow("path cannot contain query");
  });
});

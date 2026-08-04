import { isIP } from "node:net";
import { z } from "zod";
import { CursorPageSchema, CursorQuerySchema } from "./pagination";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDomain(value: string): boolean {
	const domain = value.startsWith("*.") ? value.slice(2) : value;
	return (
		domain.length <= 253 &&
		!domain.endsWith(".") &&
		isIP(domain) === 0 &&
		domain.split(".").length >= 2 &&
		domain.split(".").every((label) => DOMAIN_LABEL.test(label))
	);
}

export const NetworkRuleSchema = z
	.object({
		domain: z.string().refine(isDomain, "expected a lowercase ASCII domain or leading *. wildcard"),
		ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(32).default([80, 443]),
		allowPrivate: z.boolean().default(false),
	})
	.superRefine((rule, ctx) => {
		if (new Set(rule.ports).size !== rule.ports.length) {
			ctx.addIssue({ code: "custom", path: ["ports"], message: "ports must be unique" });
		}
	});

const UnrestrictedNetworkPolicySchema = z.object({ mode: z.literal("unrestricted") });
const RestrictedNetworkPolicySchema = z.object({
	mode: z.literal("restricted"),
	allow: z.array(NetworkRuleSchema).max(256).default([]),
});

export const NetworkPolicySchema = z.preprocess(
	(value) => value ?? { mode: "unrestricted" },
	z.discriminatedUnion("mode", [UnrestrictedNetworkPolicySchema, RestrictedNetworkPolicySchema]),
);

export type NetworkRule = z.infer<typeof NetworkRuleSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

function matchesDomain(pattern: string, host: string): boolean {
	if (!pattern.startsWith("*.")) return host === pattern;
	const suffix = pattern.slice(1);
	return host.endsWith(suffix) && host.length > suffix.length;
}

export function findNetworkRule(
	policy: NetworkPolicy,
	host: string,
	port: number,
): NetworkRule | null {
	if (policy.mode !== "restricted") return null;
	const normalized = host.toLowerCase();
	return (
		policy.allow.find(
			(rule) => rule.ports.includes(port) && matchesDomain(rule.domain, normalized),
		) ?? null
	);
}

function ipv4Number(address: string): number {
	return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inV4Range(address: number, base: string, bits: number): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (address & mask) === (ipv4Number(base) & mask);
}

export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const value = ipv4Number(address);
		return [
			["0.0.0.0", 8],
			["10.0.0.0", 8],
			["100.64.0.0", 10],
			["127.0.0.0", 8],
			["169.254.0.0", 16],
			["172.16.0.0", 12],
			["192.0.0.0", 24],
			["192.0.2.0", 24],
			["192.168.0.0", 16],
			["198.18.0.0", 15],
			["198.51.100.0", 24],
			["203.0.113.0", 24],
			["224.0.0.0", 4],
			["240.0.0.0", 4],
		].some(([base, bits]) => inV4Range(value, base as string, bits as number));
	}
	if (family !== 6) return true;
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		return isPrivateAddress(normalized.slice("::ffff:".length));
	}
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb") ||
		normalized.startsWith("fec") ||
		normalized.startsWith("fed") ||
		normalized.startsWith("fee") ||
		normalized.startsWith("fef") ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8:")
	);
}

export const NETWORK_STATES = ["disabled", "starting", "ready", "degraded"] as const;
export type NetworkState = (typeof NETWORK_STATES)[number];

export const NetworkEventInputSchema = z.object({
	source_seq: z.number().int().positive(),
	occurred_at: z.iso.datetime(),
	decision: z.enum(["allow", "deny"]),
	transport: z.enum(["http", "https"]),
	host: z.string().min(1).max(253),
	port: z.number().int().min(1).max(65_535),
	method: z.string().max(32).nullable().default(null),
	path: z
		.string()
		.max(2048)
		.refine(
			(path) => !path.includes("?") && !path.includes("#"),
			"path cannot contain query or fragment",
		)
		.nullable()
		.default(null),
	matched_rule: z.string().max(512).nullable().default(null),
	reason: z.string().min(1).max(128),
});

export const NetworkEventBatchSchema = z.object({
	source_session_id: z.uuid(),
	events: z.array(NetworkEventInputSchema).min(1).max(100),
});

export type NetworkEventInput = z.infer<typeof NetworkEventInputSchema>;
export type NetworkEventBatch = z.infer<typeof NetworkEventBatchSchema>;

export const NetworkEventSchema = NetworkEventInputSchema.omit({ source_seq: true }).extend({
	seq: z.number().int().positive(),
	workspace_id: z.uuid(),
	source_session_id: z.uuid(),
	source_seq: z.number().int().positive(),
});

export const NetworkEventsQuerySchema = CursorQuerySchema(200, 100);
export const NetworkEventPageSchema = CursorPageSchema(NetworkEventSchema);

export type NetworkEvent = z.infer<typeof NetworkEventSchema>;

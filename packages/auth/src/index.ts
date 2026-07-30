import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Machine authentication. Keys look like `pkt_<key-id>_<secret>`; the
// database stores only a keyed digest of the secret. Plaintext is shown once
// at issue time. Event payloads are signed with a separate HMAC key.

export interface IssuedKey {
	id: string;
	token: string;
	secretDigest: Uint8Array;
}

const KEY_PREFIX = "pkt";

export function issueMachineKey(pepper: string): IssuedKey {
	const id = randomUUID();
	const secret = randomBytes(32).toString("base64url");
	return {
		id,
		token: `${KEY_PREFIX}_${id}_${secret}`,
		secretDigest: digestSecret(pepper, id, secret),
	};
}

export interface ParsedKey {
	id: string;
	secret: string;
}

// The secret is base64url and may itself contain underscores, so the token
// is parsed structurally rather than split on "_".
const KEY_RE =
	/^pkt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]+)$/;

export function parseMachineKey(token: string): ParsedKey | null {
	const match = KEY_RE.exec(token);
	if (!match) {
		return null;
	}
	return { id: match[1] as string, secret: match[2] as string };
}

export function digestSecret(pepper: string, keyId: string, secret: string): Uint8Array {
	return new Uint8Array(createHmac("sha256", pepper).update(`${keyId}:${secret}`).digest());
}

export function verifySecret(
	pepper: string,
	keyId: string,
	secret: string,
	storedDigest: Uint8Array,
): boolean {
	const computed = digestSecret(pepper, keyId, secret);
	if (computed.length !== storedDigest.length) {
		return false;
	}
	return timingSafeEqual(computed, storedDigest);
}

// One-time secrets (workspace registration, reconnect credentials) share the
// keyed-digest scheme without the composite token format.
export function generateOpaqueSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function digestOpaque(pepper: string, secret: string): Uint8Array {
	return new Uint8Array(createHmac("sha256", pepper).update(secret).digest());
}

export function verifyOpaque(pepper: string, secret: string, storedDigest: Uint8Array): boolean {
	const computed = digestOpaque(pepper, secret);
	if (computed.length !== storedDigest.length) {
		return false;
	}
	return timingSafeEqual(computed, storedDigest);
}

// Lifecycle event signing: `sha256=<hex HMAC(signingKey, timestamp + "." + body)>`.
export function signEvent(signingKey: string, timestamp: string, body: string): string {
	const mac = createHmac("sha256", signingKey).update(`${timestamp}.${body}`).digest("hex");
	return `sha256=${mac}`;
}

export function verifyEventSignature(
	signingKey: string,
	timestamp: string,
	body: string,
	signature: string,
): boolean {
	const expected = signEvent(signingKey, timestamp, body);
	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

// Redacts values that must never reach logs.
const REDACT_PATTERNS = [/pkt_[0-9a-f-]{36}_[A-Za-z0-9_-]+/g, /(authorization:?\s*bearer\s+)\S+/gi];

export function redact(text: string): string {
	let out = text;
	for (const pattern of REDACT_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	return out;
}

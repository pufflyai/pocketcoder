export type Fail = (message: string) => never;

export function parseLaunchInput(value: unknown, fail: Fail): Record<string, unknown> | undefined {
	if (typeof value !== "string") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		fail("--input must be a JSON object");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		fail("--input must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

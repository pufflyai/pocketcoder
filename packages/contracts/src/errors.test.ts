import { describe, expect, test } from "bun:test";
import { ErrorEnvelopeSchema } from "./errors";

describe("ErrorEnvelopeSchema", () => {
	test("accepts a documented error and rejects unknown codes", () => {
		expect(
			ErrorEnvelopeSchema.parse({
				error: {
					code: "auth.missing_scope",
					message: "Missing required scope.",
					request_id: "request-1",
				},
			}).error.code,
		).toBe("auth.missing_scope");
		expect(
			ErrorEnvelopeSchema.safeParse({
				error: { code: "auth.forbidden", message: "no", request_id: "request-2" },
			}),
		).toMatchObject({ success: false });
	});
});

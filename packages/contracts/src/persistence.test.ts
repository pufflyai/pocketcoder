import { describe, expect, test } from "bun:test";
import { RestoreRequestSchema } from "./persistence";

describe("restore request", () => {
	test("accepts optional opaque launch input", () => {
		expect(RestoreRequestSchema.parse({ external_id: "restored" })).toEqual({
			external_id: "restored",
		});
		expect(
			RestoreRequestSchema.parse({
				external_id: "restored-with-input",
				launch_input: { bootstrap_token: "workspace-envelope", attempt: 2 },
			}),
		).toEqual({
			external_id: "restored-with-input",
			launch_input: { bootstrap_token: "workspace-envelope", attempt: 2 },
		});
	});
});

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	LeaseAssignmentFrameSchema,
	POOL_PROTOCOL_VERSION,
	PoolProviderInputSchema,
	PoolRegisteredFrameSchema,
} from "./protocol";

describe("warm pool protocol v3", () => {
	test("unbound provider input cannot contain workspace or caller data", () => {
		const parsed = PoolProviderInputSchema.parse({
			pool_runtime_id: randomUUID(),
			server_url: "http://server:7080",
			enrollment_secret: "single-use",
			template_digest: "sha256:template",
			template_name: "fixture",
			template_version: "1.0.0",
			workspace_id: randomUUID(),
			launch_input: { secret: true },
		});
		expect("workspace_id" in parsed).toBe(false);
		expect("launch_input" in parsed).toBe(false);
	});

	test("validates one-shot enrollment and assignment frames", () => {
		const runtimeId = randomUUID();
		expect(
			PoolRegisteredFrameSchema.parse({
				v: POOL_PROTOCOL_VERSION,
				type: "pool_registered",
				pool_runtime_id: runtimeId,
				template: { name: "fixture", version: "1.0.0", digest: "sha256:template" },
				agent_version: "0.1.0",
			}).pool_runtime_id,
		).toBe(runtimeId);
		expect(
			LeaseAssignmentFrameSchema.parse({
				v: POOL_PROTOCOL_VERSION,
				type: "lease_assignment",
				input: {
					workspace_id: randomUUID(),
					server_url: "http://server:7080",
					registration_secret: "workspace-only",
					template_digest: "sha256:template",
					template_name: "fixture",
					template_version: "1.0.0",
					launch_mode: "create",
				},
			}).type,
		).toBe("lease_assignment");
	});
});

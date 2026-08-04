import { describe, expect, test } from "bun:test";
import {
	canTransition,
	isTerminal,
	REASON_CODES,
	TERMINAL_STATES,
	WORKSPACE_STATES,
	WorkspaceResourceSchema,
} from "./workspace";

test("workspace resources expose firewall state and reason", () => {
	expect(REASON_CODES).toContain("network_policy_failed");
	expect(WorkspaceResourceSchema.shape.network.parse({ state: "degraded" })).toEqual({
		state: "degraded",
	});
});

describe("workspace state machine", () => {
	test("happy path is allowed", () => {
		expect(canTransition("queued", "provisioning")).toBe(true);
		expect(canTransition("provisioning", "connected")).toBe(true);
		expect(canTransition("connected", "ready")).toBe(true);
		expect(canTransition("ready", "terminating")).toBe(true);
		expect(canTransition("terminating", "canceled")).toBe(true);
		expect(canTransition("ready", "succeeded")).toBe(true);
	});

	test("bounded launch retry is the only backward edge", () => {
		expect(canTransition("provisioning", "queued")).toBe(true);
		expect(canTransition("connected", "queued")).toBe(false);
		expect(canTransition("ready", "queued")).toBe(false);
	});

	test("terminal states never reopen", () => {
		for (const from of TERMINAL_STATES) {
			expect(isTerminal(from)).toBe(true);
			for (const to of WORKSPACE_STATES) {
				expect(canTransition(from, to)).toBe(false);
			}
		}
	});

	test("preserve is a terminal execution path", () => {
		expect(canTransition("ready", "preserving")).toBe(true);
		expect(canTransition("preserving", "preserved")).toBe(true);
		expect(isTerminal("preserved")).toBe(true);
		expect(canTransition("preserved", "queued")).toBe(false);
	});

	test("skipping connected is not allowed", () => {
		expect(canTransition("provisioning", "ready")).toBe(false);
		expect(canTransition("queued", "ready")).toBe(false);
		expect(canTransition("queued", "connected")).toBe(false);
	});
});

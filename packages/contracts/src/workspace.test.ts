import { describe, expect, test } from "bun:test";
import { canTransition, isTerminal, TERMINAL_STATES, WORKSPACE_STATES } from "./workspace";

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

	test("skipping connected is not allowed", () => {
		expect(canTransition("provisioning", "ready")).toBe(false);
		expect(canTransition("queued", "ready")).toBe(false);
		expect(canTransition("queued", "connected")).toBe(false);
	});
});

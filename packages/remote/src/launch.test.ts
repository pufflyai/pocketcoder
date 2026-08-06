import { describe, expect, test } from "bun:test";
import { extensionPath, resolvePiInvocation } from "./launch";

describe("pi launcher", () => {
	test("requires a machine key with actionable guidance", () => {
		expect(() => resolvePiInvocation({ env: {} })).toThrow("POCKETCODER_KEY is required");
	});

	test("builds the pinned thin-client invocation", () => {
		const invocation = resolvePiInvocation({
			env: {
				POCKETCODER_URL: "http://127.0.0.1:7080",
				POCKETCODER_KEY: "pkt_example",
				POCKETCODER_WORKSPACE_ID: "ws-1",
				OPENAI_API_KEY: "sk-should-be-stripped",
			},
			argv: ["initial prompt"],
			execPath: "/usr/bin/node-test",
		});

		expect(invocation.command).toBe("/usr/bin/node-test");
		expect(invocation.args[0]).toEndWith("dist/cli.js");
		expect(invocation.args[0]).toContain("pi-coding-agent");
		expect(invocation.args.slice(1)).toEqual([
			"--provider",
			"pocketcoder-agentapi",
			"--model",
			"remote-agent",
			"--api-key",
			"local-ui",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-session",
			"--offline",
			"--extension",
			expect.stringMatching(/packages\/remote\/src\/extension\.ts$/) as unknown as string,
			"initial prompt",
		]);
		expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
		expect(invocation.env.POCKETCODER_KEY).toBe("pkt_example");
	});
});

describe("extension resolution", () => {
	test("loads the TypeScript entry when running from source", () => {
		expect(extensionPath("/repo/packages/remote/src")).toBe(
			"/repo/packages/remote/src/extension.ts",
		);
	});

	// The published tarball ships no src/, so the launcher must point pi at the
	// bundled extension that carries the workspace-only dependencies inline.
	test("loads the bundled entry when running from the published tarball", () => {
		expect(extensionPath("/app/node_modules/@pstdio/pocketcoder-remote/dist")).toBe(
			"/app/node_modules/@pstdio/pocketcoder-remote/dist/extension.js",
		);
	});
});

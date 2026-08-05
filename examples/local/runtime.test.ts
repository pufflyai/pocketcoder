import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LOCAL_PI_PRINCIPAL_SCOPES, requireOpenAIKey, resolveLocalPiOptions } from "./options";
import { type LocalCommandRunner, preparePiRuntime } from "./runtime";

describe("local Pi operator options", () => {
	test("grants the local Pi client permission to upload attachments", () => {
		expect(LOCAL_PI_PRINCIPAL_SCOPES).toContain("attachments:write");
	});

	test("resolves explicit model and gateway settings without requiring a provider key", () => {
		const options = resolveLocalPiOptions({
			argv: ["bun", "prepare.ts", "--template", "pi-harness", "--openai"],
			env: {
				OPENAI_MODEL: "gpt-test",
				PI_GATEWAY_PORT: "8090",
			},
			root: "/operator/repo",
		});

		expect(options).toMatchObject({
			template: "pi-harness",
			useOpenAI: true,
			gatewayPort: 8090,
			gatewayUrl: "http://host.docker.internal:8090/v1",
			gatewayModel: "gpt-test",
			gatewayApi: "openai-responses",
		});
		expect(() => requireOpenAIKey(true, {})).toThrow("OPENAI_API_KEY");
	});
});

describe("local Pi runtime materialization", () => {
	test("renders an idempotent digest-pinned template and rotates the bearer per prepare", async () => {
		const directory = await mkdtemp(resolve(tmpdir(), "pocketcoder-local-runtime-"));
		const commands: string[][] = [];
		const command: LocalCommandRunner = async (args) => {
			commands.push(args);
			return {
				stdout: args.includes("inspect") ? `sha256:${"a".repeat(64)}` : "",
				stderr: "",
			};
		};
		try {
			const options = {
				root: resolve(import.meta.dir, "../.."),
				outputDir: resolve(directory, "templates"),
				secretRoot: resolve(directory, "secrets"),
				gatewayUrl: "http://host.docker.internal:8080/v1",
				gatewayModel: "gpt-test",
				command,
			};
			const first = await preparePiRuntime(options);
			const second = await preparePiRuntime(options);
			expect(first.templateVersion).toBe(second.templateVersion);
			expect(first.templateVersion).toMatch(/^1\.0\.0-local\.[0-9a-f]{12}$/);
			expect(first.image).toBe(`pocketcoder-pi:local@sha256:${"a".repeat(64)}`);
			// A bearer that survives re-prepare is a standing credential — the
			// antipattern docs/security.md exists to prevent. Every prepare mints
			// a fresh one; stale workspaces lose gateway access, which is correct.
			expect(first.bearer).not.toBe(second.bearer);

			const template = await readFile(first.templatePath, "utf8");
			expect(template).toContain('"PI_GATEWAY_BEARER_REF": "secretRef:pi-gateway/bearer"');
			expect(template).not.toContain(first.bearer);
			expect((await stat(first.bearerPath)).mode & 0o777).toBe(0o444);
			expect(commands.filter((args) => args.includes("build"))).toHaveLength(2);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

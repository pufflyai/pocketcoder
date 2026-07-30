import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ProviderInput,
	parseTemplateManifest,
	snapshotOf,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { DockerDriver, resolveDockerImage } from "./docker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function dockerMock(source: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-test-"));
	temporaryDirectories.push(directory);
	const executable = join(directory, "docker");
	await writeFile(executable, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 });
	return executable;
}

describe("Docker image resolution", () => {
	test("uses an exact local image ID for a locally built digest reference", async () => {
		const digest = `sha256:${"a".repeat(64)}`;
		const docker = await dockerMock(`
const args = process.argv.slice(2);
if (args.join(" ") !== "image inspect ${digest} --format {{.Id}}") process.exit(2);
console.log("${digest}");
`);

		expect(await resolveDockerImage(docker, `pocketcoder-example:test@${digest}`)).toBe(digest);
	});

	test("keeps a repository digest when it is not a local image ID", async () => {
		const digest = `sha256:${"b".repeat(64)}`;
		const image = `registry.example/workspace@${digest}`;
		const docker = await dockerMock("process.exit(1);");

		expect(await resolveDockerImage(docker, image)).toBe(image);
	});

	test("mounts opaque local storage and deployment secret files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-launch-"));
		temporaryDirectories.push(directory);
		const log = join(directory, "args.json");
		const docker = await dockerMock(`
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "image") {
  console.log(args[2]);
} else if (args[0] === "run") {
  writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
  console.log("container-id");
}
`);
		const parsed = parseTemplateManifest({
			apiVersion: "pocketcoder.dev/v1alpha1",
			kind: "Template",
			metadata: { name: "docker-persistent" },
			spec: {
				version: "1.0.0",
				image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
				harness: { command: ["/bin/true"] },
				env: {
					SAFE_VALUE: "yes",
					MODEL_KEY_FILE: "secretRef:model/key",
				},
				resources: { cpu: "1", memory: "256Mi" },
				security: { writableMemoryPaths: ["/tmp"] },
			},
		});
		const workspaceId = randomUUID();
		const workspace = {
			id: workspaceId,
			templateDigest: parsed.digest,
			templateSnapshot: snapshotOf(parsed),
		} as WorkspaceRow;
		const input: ProviderInput = {
			workspace_id: workspaceId,
			server_url: "http://host.docker.internal:7080",
			registration_secret: "one-time",
			template_digest: parsed.digest,
			template_name: "docker-persistent",
			template_version: "1.0.0",
			launch_mode: "create",
		};
		const driver = new DockerDriver({
			dockerBin: docker,
			inputDir: join(directory, "input"),
		});
		await driver.create({
			workspace,
			input,
			mounts: [
				{
					name: "worktree",
					target: "/workspace",
					source: {
						kind: "host-path",
						path: join(directory, "workspaces", workspaceId),
					},
				},
			],
			secrets: [
				{
					name: "model-key",
					target: "/run/pocketcoder/secrets/model%2Fkey",
					source: {
						kind: "host-path",
						path: join(directory, "secrets", "model-key"),
					},
				},
			],
		});
		const args = JSON.parse(await readFile(log, "utf8")) as string[];
		expect(args.join(" ")).toContain(
			`src=${join(directory, "workspaces", workspaceId)},dst=/workspace`,
		);
		expect(args.join(" ")).toContain(
			`src=${join(directory, "secrets", "model-key")},dst=/run/pocketcoder/secrets/model%2Fkey,readonly`,
		);
		expect(args).not.toContain("MODEL_KEY_FILE=secretRef:model/key");
	});
});

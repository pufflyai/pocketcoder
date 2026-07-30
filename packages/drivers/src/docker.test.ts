import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDockerImage } from "./docker";

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
});

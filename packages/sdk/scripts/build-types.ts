import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { rollup } from "rollup";
import dts from "rollup-plugin-dts";

const packageDir = join(import.meta.dir, "..");
const typeDir = await mkdtemp(join(packageDir, ".types-"));

try {
	const compiler = Bun.spawn(
		[
			join(packageDir, "node_modules/.bin/tsc"),
			"--project",
			join(packageDir, "tsconfig.build.json"),
			"--outDir",
			typeDir,
		],
		{ cwd: packageDir, stdout: "inherit", stderr: "inherit" },
	);
	if ((await compiler.exited) !== 0) throw new Error("SDK declaration emit failed");

	const bundle = await rollup({
		input: join(typeDir, "sdk/src/index.d.ts"),
		external: ["zod", "node:crypto", "node:net"],
		plugins: [
			dts({
				respectExternal: true,
				compilerOptions: {
					baseUrl: typeDir,
					paths: {
						"@pstdio/pocketcoder-contracts": ["contracts/src/index.d.ts"],
					},
				},
			}),
		],
	});
	await bundle.write({ file: join(packageDir, "dist/index.d.ts"), format: "es" });
	await bundle.close();
} finally {
	await rm(typeDir, { recursive: true, force: true });
}

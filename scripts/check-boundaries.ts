interface SourceFile {
	path: string;
	text: string;
}

export function boundaryViolations(files: SourceFile[]): string[] {
	const violations: string[] = [];
	for (const file of files) {
		if (/["'](?:\.\.\/)+(?:apps|packages)\/[^"']+\/src(?:\/|["'])/.test(file.text)) {
			violations.push(`${file.path}: deep source import bypasses a package export`);
		}
		if (
			!file.path.endsWith(".test.ts") &&
			!file.path.endsWith(".spec.ts") &&
			/["']@pstdio\/pocketcoder-testkit["']/.test(file.text)
		) {
			violations.push(`${file.path}: production code imports testkit`);
		}
	}
	return violations;
}

async function sourceFiles(): Promise<SourceFile[]> {
	const process = Bun.spawn(["rg", "--files", "apps", "packages", "examples", "-g", "*.ts"], {
		stdout: "pipe",
	});
	const [output, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error("could not enumerate TypeScript source files");
	return await Promise.all(
		output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(async (path) => ({ path, text: await Bun.file(path).text() })),
	);
}

if (import.meta.main) {
	const violations = boundaryViolations(await sourceFiles());
	if (violations.length > 0) {
		for (const violation of violations) console.error(violation);
		process.exit(1);
	}
	console.log("Package boundaries are valid.");
}

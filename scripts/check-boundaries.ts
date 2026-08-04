interface SourceFile {
	path: string;
	text: string;
}

export interface ProjectBoundary {
	path: string;
	name: string;
	tags: string[];
	dependencies: string[];
}

const DISALLOWED_DEPENDENCY_TYPES: Record<string, ReadonlySet<string>> = {
	"type:library": new Set(["type:application", "type:adapter", "type:app", "type:test"]),
	"type:ports": new Set(["type:application", "type:adapter", "type:app", "type:test"]),
	"type:application": new Set(["type:adapter", "type:app", "type:test"]),
	"type:adapter": new Set(["type:app", "type:test"]),
	"type:app": new Set(["type:test"]),
};

export function projectBoundaryViolations(projects: ProjectBoundary[]): string[] {
	const byName = new Map(projects.map((project) => [project.name, project]));
	const violations: string[] = [];
	for (const project of projects) {
		const type = project.tags.find((tag) => tag.startsWith("type:"));
		if (!type) {
			violations.push(`${project.path}: project requires an Nx type tag`);
			continue;
		}
		for (const dependencyName of project.dependencies) {
			const dependency = byName.get(dependencyName);
			const dependencyType = dependency?.tags.find((tag) => tag.startsWith("type:"));
			if (dependencyType && DISALLOWED_DEPENDENCY_TYPES[type]?.has(dependencyType)) {
				violations.push(
					`${project.path}: ${type} cannot depend on ${dependencyType} (${dependencyName})`,
				);
			}
		}
	}
	return violations;
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

async function projectBoundaries(): Promise<ProjectBoundary[]> {
	const process = Bun.spawn(["rg", "--files", "apps", "packages", "-g", "package.json"], {
		stdout: "pipe",
	});
	const [output, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error("could not enumerate project manifests");
	return await Promise.all(
		output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(async (path) => {
				const manifest = (await Bun.file(path).json()) as {
					name: string;
					nx?: { tags?: string[] };
					dependencies?: Record<string, string>;
				};
				return {
					path,
					name: manifest.name,
					tags: manifest.nx?.tags ?? [],
					dependencies: Object.keys(manifest.dependencies ?? {}),
				};
			}),
	);
}

if (import.meta.main) {
	const violations = [
		...boundaryViolations(await sourceFiles()),
		...projectBoundaryViolations(await projectBoundaries()),
	];
	if (violations.length > 0) {
		for (const violation of violations) console.error(violation);
		process.exit(1);
	}
	console.log("Package boundaries are valid.");
}

import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface SourceFile {
  path: string;
  text: string;
}

export interface ProjectBoundary {
  path: string;
  name: string;
  tags: string[];
  private: boolean;
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

// A published package resolves its runtime dependencies from npm, so anything a
// workspace keeps private has to be bundled at build time and declared as a dev
// dependency instead.
export function publishedDependencyViolations(projects: ProjectBoundary[]): string[] {
  const byName = new Map(projects.map((project) => [project.name, project]));
  const violations: string[] = [];
  for (const project of projects) {
    if (project.private) continue;
    for (const dependencyName of project.dependencies) {
      if (byName.get(dependencyName)?.private) {
        violations.push(
          `${project.path}: published package cannot depend on unpublished ${dependencyName}`,
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

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

async function filesUnder(root: string, suffix: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      paths.push(...(await filesUnder(path, suffix)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      paths.push(path);
    }
  }
  return paths;
}

async function sourceFiles(): Promise<SourceFile[]> {
  const paths = (
    await Promise.all(["packages", "examples"].map((root) => filesUnder(root, ".ts")))
  ).flat();
  return await Promise.all(
    paths.map(async (path) => ({ path, text: await Bun.file(path).text() })),
  );
}

async function projectBoundaries(): Promise<ProjectBoundary[]> {
  const paths = await filesUnder("packages", "package.json");
  return await Promise.all(
    paths.map(async (path) => {
      const manifest = (await Bun.file(path).json()) as {
        name: string;
        private?: boolean;
        nx?: { tags?: string[] };
        dependencies?: Record<string, string>;
      };
      return {
        path,
        name: manifest.name,
        tags: manifest.nx?.tags ?? [],
        private: manifest.private === true,
        dependencies: Object.keys(manifest.dependencies ?? {}),
      };
    }),
  );
}

if (import.meta.main) {
  const projects = await projectBoundaries();
  const violations = [
    ...boundaryViolations(await sourceFiles()),
    ...projectBoundaryViolations(projects),
    ...publishedDependencyViolations(projects),
  ];
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log("Package boundaries are valid.");
}

import { existsSync } from "node:fs";
import { command } from "./command";
import { assertSuiteCoverage, suiteGroups } from "./suite";

const target = process.argv[2];
const projects: string[] = JSON.parse(process.env.CI_PROJECTS ?? "[]");
if (target === "unit" || target === "typecheck") {
  if (!projects.length) throw new Error("An affected task needs at least one project");
  const args = [
    "bun",
    "x",
    "nx",
    "run-many",
    `--target=${target === "unit" ? "test" : target}`,
    `--projects=${projects.join(",")}`,
    "--parallel=2",
    "--outputStyle=stream",
  ];
  if (target === "unit") {
    const shard = process.env.CI_SHARD;
    if (!shard) throw new Error("Unit tests require an explicit shard");
    args.push(
      "--",
      `--shard=${shard}/4`,
      "--pass-with-no-tests",
      "--path-ignore-patterns=**/*conformance.test.ts",
      "--path-ignore-patterns=**/*.benchmark.test.ts",
    );
  }
  await command(args);
  if (target === "typecheck") {
    for (const path of [
      "examples/resume/tsconfig.json",
      "examples/native/tsconfig.json",
      "scripts/tsconfig.images.json",
      "scripts/tsconfig.monitoring.json",
      "scripts/tsconfig.recovery.json",
      "scripts/tsconfig.ci.json",
    ]) {
      if (existsSync(path)) await command(["bun", "x", "tsc", "--project", path]);
    }
    if (existsSync(".pstdio/extensions/pocketcoder/tsconfig.json"))
      await command(["bun", "run", "--cwd", ".pstdio/extensions/pocketcoder", "typecheck"]);
  }
} else {
  const manifest = await Bun.file("package.json").json();
  const required = assertSuiteCoverage(manifest.scripts["test:all"]);
  const commands = suiteGroups[target as keyof typeof suiteGroups];
  if (!commands) throw new Error(`Unknown full test group: ${target}`);
  for (const script of commands) {
    if (required.includes(script)) await command(["bun", "--no-env-file", "run", script]);
  }
}

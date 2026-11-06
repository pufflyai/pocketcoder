import { generatedManagedContract } from "../packages/contracts/src/sessions/artifacts";

const generated = generatedManagedContract();
for (const [name, value] of [
  ["contracts.schema", generated.schema],
  ["openapi", generated.openapi],
] as const) {
  const file = new URL(`../packages/contracts/src/sessions/generated/${name}.json`, import.meta.url);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!(await Bun.file(file).exists()) || JSON.stringify(await Bun.file(file).json()) !== JSON.stringify(value))
      throw new Error(`Stale managed contract artifact: ${name}`);
  } else await Bun.write(file, text);
}

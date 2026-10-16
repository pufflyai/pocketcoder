export const suiteGroups = {
  integration: ["test:browser", "test:integration"],
  performance: ["test:performance"],
  contracts: [
    "test:deploy",
    "example:test",
    "check-licenses:test",
    "check-boundaries:test",
    "pack:check:test",
    "images:check:test",
    "ci:test",
  ],
};

export function assertSuiteCoverage(script: string) {
  const commands = script.split("&&").map((command) => command.trim().replace(/^bun run /, ""));
  const assigned = ["test:unit", ...Object.values(suiteGroups).flat()];
  const missing = commands.filter((command) => !assigned.includes(command));
  if (missing.length) throw new Error(`Assign root test commands to full CI: ${missing.join(", ")}`);
  if (new Set(assigned).size !== assigned.length) throw new Error("A root test command has multiple CI owners");
  return commands;
}

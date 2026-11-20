// Candidate-owned exports execute in a workspace, never on the operator host.
// This supports computed platforms and fails when the candidate changes its contract.
export const DISCOVERY_COMMAND = `bun -e 'const p = await import("./scripts/ci/production-platforms.ts"); const rows = [...p.productionDesktopPlatforms("stable"), ...p.productionToolchainPlatforms("stable"), ...p.productionBenchmarkPlatforms()]; const targets = [...new Set(rows.map(r => r.target ?? r.platform_pkg?.replace(/^cli-/, "").replace(/^win-/, "win32-")))]; if (!targets.length || targets.some(t => typeof t !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(t))) throw new Error("Invalid candidate platforms"); console.log("REMOTE_TEST_TARGETS " + JSON.stringify(targets));'`;

export function requiredTargets(log: string) {
  const line = log.split("\n").findLast((line) => line.startsWith("REMOTE_TEST_TARGETS "));
  if (!line) throw new Error("Candidate platform discovery did not return targets");
  const targets: unknown = JSON.parse(line.slice("REMOTE_TEST_TARGETS ".length));
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    targets.some((t) => typeof t !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(t))
  )
    throw new Error("Invalid candidate targets");
  return [...new Set(targets)] as string[];
}

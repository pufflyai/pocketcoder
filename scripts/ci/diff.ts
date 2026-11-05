export function comparisonBase(event: string, head: string, base?: string) {
  // The checkout is GitHub's merge candidate; event metadata can lag its actual base.
  if (event === "pull_request") return `${head}^1`;
  if (!base || /^0+$/.test(base)) return undefined;
  return base;
}

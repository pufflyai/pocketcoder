export function runUrlLifetime(deadlineAt: string, requested: number, now = Date.now()) {
  const remaining = Math.floor((Date.parse(deadlineAt) - now) / 1000);
  if (remaining < 1) throw new Error("Workspace deadline has expired");
  return Math.min(requested, remaining);
}

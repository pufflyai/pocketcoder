export function imageBuildCommand(role: string, arch: string, enabled: boolean, writable: boolean) {
  if (!enabled) return ["docker", "build"];
  // Derived images consume the workspace tag loaded in the host Docker store.
  if (role === "desktop" || role === "browser") return ["docker", "build", "--builder", "default"];
  const scope = `candidate-${role}-${arch}`;
  const args = ["docker", "buildx", "build", "--load", "--cache-from", `type=gha,scope=${scope}`];
  if (writable) args.push("--cache-to", `type=gha,scope=${scope},mode=max`);
  return args;
}

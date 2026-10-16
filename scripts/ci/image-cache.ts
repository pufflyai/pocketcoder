export function imageBuildCommand(role: string, arch: string, enabled: boolean, writable: boolean) {
  if (!enabled) return ["docker", "build"];
  const scope = `candidate-${role}-${arch}`;
  const args = ["docker", "buildx", "build", "--load", "--cache-from", `type=gha,scope=${scope}`];
  if (writable) args.push("--cache-to", `type=gha,scope=${scope},mode=max`);
  return args;
}

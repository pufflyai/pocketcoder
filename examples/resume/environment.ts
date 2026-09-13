export function isolatedEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "TERM",
    "COLORTERM",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

export function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

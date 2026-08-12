const installDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const localOnlyProtocols = [
  "workspace:",
  "catalog:",
  "file:",
  "link:",
  "portal:",
  "patch:",
  "exec:",
  "git+file:",
];

interface PublishableManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function isLocalOnlyRange(range: string) {
  const value = range.trim();
  return (
    localOnlyProtocols.some((protocol) => value.startsWith(protocol)) ||
    [".", ".."].includes(value) ||
    ["./", "../", "/", "~/", ".\\", "..\\", "\\", "~\\"].some((prefix) =>
      value.startsWith(prefix),
    ) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function assertNoLocalInstallDependencies(manifest: PublishableManifest) {
  const localDependencies = installDependencyFields.flatMap((field) =>
    Object.entries(manifest[field] ?? {})
      .filter(([, range]) => isLocalOnlyRange(range))
      .map(([name, range]) => `${field}.${name} (${range})`),
  );

  if (localDependencies.length === 0) return;

  throw new Error(
    `${manifest.name ?? "Publishable package"} has local-only install dependencies: ${localDependencies.join(
      ", ",
    )}`,
  );
}

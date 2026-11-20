type Package = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lock = { packages?: Record<string, [string, ...unknown[]]> };

// Version ranges name a dependency; the frozen lock names the browser build it needs.
export function browserPin(manifests: Package[], text: string) {
  const names = ["playwright", "@playwright/test"];
  const declared = manifests.flatMap((pkg) =>
    names.flatMap((name) => {
      const version = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
      return version ? [{ name, version }] : [];
    }),
  );
  if (!declared.length) return;
  const lock = Bun.JSONC.parse(text) as Lock;
  const frozen = Object.entries(lock.packages ?? {})
    .filter(([key]) => names.some((name) => key === name || key.endsWith(`/${name}`)))
    .map(([, value]) => value[0].match(/^(?:playwright|@playwright\/test)@(\d+\.\d+\.\d+)$/)?.[1]);
  const pins = frozen.length ? frozen : declared.map(({ version }) => version);
  const pin = pins[0];
  if (
    pin &&
    /^\d+\.\d+\.\d+$/.test(pin) &&
    pins.every((value) => value === pin) &&
    declared.every(({ version }) => Bun.semver.satisfies(pin, version))
  )
    return pin;
}

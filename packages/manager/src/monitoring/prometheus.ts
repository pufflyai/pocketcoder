export function prometheus() {
  const lines: string[] = [];
  const names = new Set<string>();
  return {
    add(suffix: string, value: number | null, labels: Record<string, string> = {}) {
      const name = `pocketcoder_${suffix}`;
      if (!names.has(name)) {
        lines.push(`# TYPE ${name} gauge`);
        names.add(name);
      }
      const entries = Object.entries(labels).map(([key, label]) => `${key}=${JSON.stringify(label)}`);
      lines.push(`${name}${entries.length ? `{${entries.join(",")}}` : ""} ${value ?? "NaN"}`);
    },
    text: () => `${lines.join("\n")}\n`,
  };
}

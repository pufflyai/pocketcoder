export const imageRoles = ["server", "workspace", "desktop", "browser", "egress", "manager"] as const;
export const imageArchitectures = ["amd64", "arm64"] as const;

type Scan = {
  SchemaVersion: number;
  Results?: { Target: string; Vulnerabilities?: { VulnerabilityID: string; Severity: string }[] }[];
};

export function assertImageScan(scan: Scan) {
  if (scan.SchemaVersion !== 2 || !scan.Results?.length) throw new Error("Image scan results are missing");
  const findings = scan.Results.flatMap((result) =>
    (result.Vulnerabilities ?? [])
      .filter((v) => v.Severity === "HIGH" || v.Severity === "CRITICAL")
      .map((v) => `${result.Target}: ${v.VulnerabilityID} (${v.Severity})`),
  );
  if (findings.length) throw new Error(`Image release gate failed:\n${findings.join("\n")}`);
}

type Identity = { role: string; arch: string; commit: string; channel: string; result: string };

export function assertImageSet(records: Identity[], commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full source commit is required");
  const expected = new Set(imageRoles.flatMap((role) => imageArchitectures.map((arch) => `${role}/${arch}`)));
  const seen = new Set<string>();
  for (const record of records) {
    if (record.commit !== commit) throw new Error("Image source commit differs");
    if (record.channel !== "candidate" || record.result !== "passed")
      throw new Error("Only passing candidate images may be published");
    const key = `${record.role}/${record.arch}`;
    if (!expected.has(key)) throw new Error(`Unsupported image: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate image: ${key}`);
    seen.add(key);
  }
  for (const key of expected) if (!seen.has(key)) throw new Error(`Image is missing: ${key}`);
}

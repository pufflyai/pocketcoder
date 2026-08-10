// Duration strings used by template timeouts, e.g. "15s", "20m", "2h".

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function isDuration(value: string): boolean {
  return DURATION_RE.test(value);
}

export function parseDurationMs(value: string): number {
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] as string];
  if (unit === undefined) {
    throw new Error(`invalid duration unit: ${value}`);
  }
  return amount * unit;
}

export const SAMPLE_INTERVAL_MS = 60_000;
export function sampleBucket(at: Date) {
  return new Date(Math.floor(+at / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS);
}

export function retainedSince(at: Date) {
  const cutoff = new Date(at);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return cutoff;
}

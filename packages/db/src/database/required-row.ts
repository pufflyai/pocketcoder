// Inserts with RETURNING and aggregate queries promise one row on success.
export function requiredRow<T>(row: T | null | undefined): T {
  if (row == null) throw new Error("database query returned no row");
  return row;
}

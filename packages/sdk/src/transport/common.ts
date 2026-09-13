export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorListQuery {
  limit?: number;
  cursor?: string;
}

export function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export function page<T>(body: { items: T[]; next_cursor: string | null }): Page<T> {
  return { items: body.items, nextCursor: body.next_cursor };
}

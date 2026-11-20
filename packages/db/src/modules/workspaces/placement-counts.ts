import { type SQLWrapper, sql } from "drizzle-orm";
// Immutable runtime snapshots carry placement, including snapshots of retired template versions.
export const placementValue = (snapshot: SQLWrapper) =>
  sql<string>`coalesce(${snapshot}->'spec'->>'placement', 'default')`;

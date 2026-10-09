import type { ActiveCounts } from "@pstdio/pocketcoder-runtime-contracts";
import { asc, count, eq, getColumns, inArray, sql } from "drizzle-orm";
import { compileStaticSelect } from "../../database/compiled-select";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { workspaceFromRow } from "./mapping";

export function createAdmissionSnapshot({ client, db, tables: { workspaces } }: DatabaseContext) {
  function prepare() {
    const queued = db.$with("queued_workspaces").as(
      db
        .select({
          ...getColumns(workspaces),
          queuedCount: sql<number>`count(*) over ()`.mapWith(Number).as("queued_count"),
        })
        .from(workspaces)
        .where(eq(workspaces.state, "queued")),
    );
    const heads = db
      .selectDistinctOn([queued.principalId])
      .from(queued)
      .orderBy(asc(queued.principalId), asc(queued.createdAt), asc(queued.id))
      .as("heads");
    const active = db.$with("active_workspaces").as(
      db
        .select({ principalId: workspaces.principalId, templateName: workspaces.templateName, n: count().as("n") })
        .from(workspaces)
        .where(inArray(workspaces.state, ["provisioning", "connected", "ready", "preserving", "terminating"]))
        .groupBy(workspaces.principalId, workspaces.templateName),
    );
    const summary = db.$with("active_summary").as(
      db
        .select({
          groups: sql<
            Array<[string, string, number]>
          >`coalesce(jsonb_agg(jsonb_build_array(${active.principalId}, ${active.templateName}, ${active.n})), '[]'::jsonb)`.as(
            "groups",
          ),
        })
        .from(active),
    );
    const query = db
      .with(queued, active, summary)
      .select({ head: getColumns(heads), groups: summary.groups })
      .from(summary)
      .leftJoin(heads, sql`true`)
      .orderBy(asc(heads.createdAt), asc(heads.id));
    return compileStaticSelect(client, query, { active_summary: true, heads: false });
  }
  let statement: ReturnType<typeof prepare> | undefined;
  return async () => {
    statement ??= prepare();
    const rows = await statement();
    const first = requiredRow(rows[0]);
    const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
    for (const [principal, template, n] of first.groups) {
      counts.global += n;
      counts.byPrincipal[principal] = (counts.byPrincipal[principal] ?? 0) + n;
      counts.byTemplate[template] = (counts.byTemplate[template] ?? 0) + n;
    }
    const queued = [];
    for (const { head } of rows) {
      if (!head) continue;
      const { queuedCount: _count, ...workspace } = head;
      queued.push(workspaceFromRow(workspace));
    }
    return { counts, queued, queuedCount: first.head?.queuedCount ?? 0 };
  };
}

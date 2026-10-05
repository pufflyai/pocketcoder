import { and, asc, eq, getColumns, isNotNull, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DatabaseContext, Transaction } from "../../database/context";

export function createWarmClaimQuery({
  db,
  tables: { warmPoolRuntimes: runtimes, workspaces, workspaceStateHistory: history, eventOutbox: outbox },
}: DatabaseContext) {
  const ready = db
    .select({ id: runtimes.id })
    .from(runtimes)
    .where(
      and(
        eq(runtimes.templateDigest, sql.placeholder("templateDigest")),
        eq(runtimes.driverKind, sql.placeholder("driverKind")),
        eq(runtimes.eligibilityFingerprint, sql.placeholder("eligibilityFingerprint")),
        eq(runtimes.state, "ready"),
        isNotNull(runtimes.providerRef),
      ),
    )
    .orderBy(asc(runtimes.readyAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const leased = db.$with("leased_runtime").as(
    db
      .update(runtimes)
      .set({
        state: "leasing",
        workspaceId: sql.placeholder("workspaceId"),
        leasedAt: sql`${sql.param(sql.placeholder("at"), runtimes.leasedAt)}`,
        updatedAt: sql`${sql.param(sql.placeholder("at"), runtimes.updatedAt)}`,
      })
      .where(and(eq(runtimes.id, ready), eq(runtimes.state, "ready")))
      .returning(),
  );
  const admitted = db.$with("admitted_workspace").as(
    db
      .update(workspaces)
      .set({
        state: "provisioning",
        provisioningMode: "warm",
        providerKind: sql`${leased.driverKind}`,
        providerRef: sql`${leased.providerRef}`,
        registrationDigest: sql`${sql.param(sql.placeholder("registrationDigest"), workspaces.registrationDigest)}`,
        registrationExpiresAt: sql`${sql.param(sql.placeholder("registrationExpiresAt"), workspaces.registrationExpiresAt)}`,
        launchAttempts: sql`${workspaces.launchAttempts}+1`,
        updatedAt: sql`${sql.param(sql.placeholder("at"), workspaces.updatedAt)}`,
        changeSeq: sql`${workspaces.changeSeq}+1`,
      })
      .from(leased)
      .where(and(eq(workspaces.id, sql.placeholder("workspaceId")), eq(workspaces.state, "queued")))
      .returning(getColumns(workspaces)),
  );
  const recorded = db.$with("recorded_transition").as(
    db
      .insert(history)
      .select(
        db
          .select({
            id: sql<string>`${sql.placeholder("historyId")}`.as("id"),
            workspaceId: admitted.id,
            fromState: sql<"queued">`'queued'`.as("from_state"),
            toState: admitted.state,
            reasonCode: sql<null>`null`.as("reason_code"),
            occurredAt: sql<Date>`${sql.param(sql.placeholder("at"), history.occurredAt)}`.as("occurred_at"),
          })
          .from(admitted),
      )
      .returning({ id: history.id }),
  );
  const emitted = db.$with("emitted_transition").as(
    db
      .insert(outbox)
      .select(
        db
          .select({
            id: sql<string>`${sql.placeholder("eventId")}`.as("id"),
            workspaceId: admitted.id,
            eventType: sql<string>`${sql.placeholder("eventType")}`.as("event_type"),
            payload: sql<unknown>`${sql.param(sql.placeholder("payload"), outbox.payload)}`.as("payload"),
            occurredAt: sql<Date>`${sql.param(sql.placeholder("at"), outbox.occurredAt)}`.as("occurred_at"),
            nextAttemptAt: sql<Date>`${sql.param(sql.placeholder("at"), outbox.nextAttemptAt)}`.as("next_attempt_at"),
          })
          .from(admitted),
      )
      .returning({ id: outbox.id }),
  );
  const query = db
    .with(leased, admitted, recorded, emitted)
    .select({ runtime: getColumns(leased), workspace: getColumns(admitted) })
    .from(leased)
    .leftJoin(admitted, eq(admitted.id, leased.workspaceId));
  type Rows = Awaited<ReturnType<typeof query.execute>>;
  const compiled = query.toSQL();
  // toSQL fills this field list with the schema's date, bytea and JSON decoders.
  const mapper = new PgDialect({ useJitMappers: false }).mapperGenerators.rows<Rows[number]>(
    query._.config.fieldsFlat!,
    { leased_runtime: true, admitted_workspace: false },
  );
  // Rebind the compiled statement to this transaction instead of retaining another session's executor.
  return (tx: Transaction, bindings: Record<string, unknown>) =>
    tx._.session.prepareQuery<{ execute: Rows }>(compiled, "arrays", false, mapper).execute(bindings);
}

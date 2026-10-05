import { and, asc, eq, getColumns, isNotNull, isNull, sql } from "drizzle-orm";
import { compileSelect } from "../../database/compiled-select";
import type { DatabaseContext } from "../../database/context";

export function buildWarmClaimQuery({
  db,
  tables: { warmPoolRuntimes: runtimes, workspaces, workspaceStateHistory: history, eventOutbox: outbox },
}: DatabaseContext) {
  const locked = db.$with("locked_workspace").as(
    db
      .select({
        id: workspaces.id,
        state: workspaces.state,
        purgeRequestedAt: workspaces.purgeRequestedAt,
        templateDigest: workspaces.templateDigest,
        changeSeq: workspaces.changeSeq,
        outputs: workspaces.outputs,
      })
      .from(workspaces)
      .where(eq(workspaces.id, sql.placeholder("workspaceId")))
      .for("update"),
  );
  const fresh = and(
    eq(locked.changeSeq, sql.placeholder("expectedChangeSeq")),
    eq(locked.outputs, sql`${sql.param(sql.placeholder("expectedOutputs"), workspaces.outputs)}`),
  );
  const eligible = and(eq(locked.state, "queued"), isNull(locked.purgeRequestedAt));
  const candidate = db
    .select({ id: runtimes.id })
    .from(runtimes)
    .where(
      and(
        eq(runtimes.templateDigest, locked.templateDigest),
        eq(runtimes.driverKind, sql.placeholder("driverKind")),
        eq(runtimes.eligibilityFingerprint, sql.placeholder("eligibilityFingerprint")),
        eq(runtimes.state, "ready"),
        isNotNull(runtimes.providerRef),
      ),
    )
    .orderBy(asc(runtimes.readyAt))
    .limit(1)
    .for("update", { skipLocked: true })
    .as("candidate");
  // A locking CTE freezes one candidate even when the planner chooses nested loops.
  const ready = db
    .$with("ready_runtime")
    .as(
      db.select({ id: candidate.id }).from(locked).innerJoinLateral(candidate, sql`true`).where(and(eligible, fresh)),
    );
  const leased = db.$with("leased_runtime").as(
    db
      .update(runtimes)
      .set({
        state: "leasing",
        workspaceId: sql.placeholder("workspaceId"),
        leasedAt: sql`${sql.param(sql.placeholder("at"), runtimes.leasedAt)}`,
        updatedAt: sql`${sql.param(sql.placeholder("at"), runtimes.updatedAt)}`,
      })
      .from(ready)
      .where(and(eq(runtimes.id, ready.id), eq(runtimes.state, "ready")))
      .returning(getColumns(runtimes)),
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
  return db
    .with(locked, ready, leased, admitted, recorded, emitted)
    .select({
      runtime: getColumns(leased),
      workspace: getColumns(admitted),
      stale: sql<boolean>`(${eligible}) and not (${fresh})`.mapWith(Boolean),
    })
    .from(locked)
    .leftJoin(leased, eq(leased.workspaceId, locked.id))
    .leftJoin(admitted, eq(admitted.id, locked.id));
}

export function createWarmClaimQuery(context: DatabaseContext) {
  return compileSelect(buildWarmClaimQuery(context), {
    locked_workspace: true,
    leased_runtime: false,
    admitted_workspace: false,
  });
}

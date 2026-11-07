import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { lock } from "../../database/context";
import { TEST_STORE_DRIVER } from "../../test-fixtures";
import { authorityContext } from "./authority-context";
import { managedFixture } from "./fixture.test";

test.skipIf(TEST_STORE_DRIVER !== "postgres")(
  "policy authorization uses the same scope lock order as reservations",
  async () => {
    const f = await managedFixture();
    const context = f.context;
    if (context.driver !== "postgres") throw new Error("PostgreSQL required");
    let contender: Promise<unknown> | undefined;
    try {
      await f.store.managed.authority.registerScope(f.keyId, f.scopeId, f.principal.id, true);
      const started = Promise.withResolvers<number>();
      await context.db.transaction(async (tx) => {
        await lock(tx, f.scopeId, 34);
        contender = context.db.transaction(async (other) => {
          const [backend] = await other
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(context.tables.managedScopes)
            .limit(1);
          if (!backend) throw new Error("Missing backend");
          started.resolve(backend.pid);
          await authorityContext(context).scope(other, f.keyId, f.scopeId, true);
          await lock(other, f.scopeId, 34);
        });
        const pid = await started.promise;
        const deadline = Date.now() + 4000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const [row] = await tx
            .select({
              waiting: sql<boolean>`exists(select 1 from pg_locks where pid = ${pid} and locktype = 'advisory' and not granted)`,
            })
            .from(context.tables.managedScopes)
            .limit(1);
          waiting = row?.waiting ?? false;
        }
        expect(waiting).toBe(true);
        // The waiter must not hold the row that the reservation needs next.
        await tx
          .select()
          .from(context.tables.managedScopes)
          .where(eq(context.tables.managedScopes.scopeId, f.scopeId))
          .for("update", { noWait: true });
      });
      await contender;
    } finally {
      await Promise.allSettled([contender]);
      await f.dispose();
    }
  },
);

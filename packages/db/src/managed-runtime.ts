import type { ManagedRuntimeStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "./database/context";
import { createManagedBudgets } from "./modules/budgets/budgets";
import { createManagedAuthority } from "./modules/managed/authority";
import { createManagedSessions } from "./modules/sessions/sessions";

export function createManagedRuntime(context: DatabaseContext): ManagedRuntimeStore {
  return {
    authority: createManagedAuthority(context),
    sessions: createManagedSessions(context),
    budgets: createManagedBudgets(context),
  };
}

import type { ManagedRuntimeStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "./database/context";
import { createManagedBudgets } from "./modules/budgets/budgets";
import { createManagedCapacity } from "./modules/budgets/capacity";
import { createManagedAuthority } from "./modules/managed/authority";
import { createManagedFiles } from "./modules/sessions/files";
import { createManagedRequests } from "./modules/sessions/requests";
import { createManagedSessions } from "./modules/sessions/sessions";

export function createManagedRuntime(context: DatabaseContext): ManagedRuntimeStore {
  return {
    authority: createManagedAuthority(context),
    sessions: createManagedSessions(context),
    budgets: createManagedBudgets(context),
    requests: createManagedRequests(context),
    files: createManagedFiles(context),
    capacity: createManagedCapacity(context),
  };
}

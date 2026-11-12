import type { ManagedRuntimeStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "./database/context";
import { createManagedCapacity } from "./modules/budgets/capacity";
import { createManagedProfiles } from "./modules/managed/profiles";
import { createManagedFiles } from "./modules/sessions/files";
import { createManagedHistory } from "./modules/sessions/history";
import { createManagedRecovery } from "./modules/sessions/recovery";
import { createManagedRequests } from "./modules/sessions/requests";
import { createManagedSessions } from "./modules/sessions/sessions";

export function createManagedRuntime(context: DatabaseContext): ManagedRuntimeStore {
  return {
    profiles: createManagedProfiles(context),
    history: createManagedHistory(context),
    recovery: createManagedRecovery(context),
    sessions: createManagedSessions(context),
    requests: createManagedRequests(context),
    files: createManagedFiles(context),
    capacity: createManagedCapacity(context),
  };
}

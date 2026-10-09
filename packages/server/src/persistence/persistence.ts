export {
  DEFAULT_PERSISTENCE_LIMITS,
  type PersistenceLimits,
  toCheckpointResource,
  toOperationResource,
} from "./persistence-base";

import type { PersistenceServiceDeps } from "./persistence-base";
import { PersistenceContext } from "./persistence-base";
import { PersistenceCheckpointService } from "./persistence-checkpoints";
import { PersistenceMaintenanceService } from "./persistence-maintenance";
import { PreservePersistenceService } from "./persistence-preserve";
import { PersistencePreserveRunner } from "./persistence-preserve-runner";
import { PersistencePurgeService } from "./persistence-purge";
import { PersistenceRestoreService } from "./persistence-restore";
import { createPersistenceTransferRecovery } from "./persistence-transfer-recovery";

export class PersistenceService {
  constructor(deps: PersistenceServiceDeps) {
    this.context = new PersistenceContext(deps);
    this.drain = this.context.drain.bind(this.context);
    this.preserveRunner = new PersistencePreserveRunner(this.context);
    const purge = new PersistencePurgeService(this.context, this.preserveRunner);
    this.purge = purge.purge.bind(purge);
    this.retryPurges = purge.retry.bind(purge);
    this.reconcileCheckpointOperation = createPersistenceTransferRecovery(this.context, this.preserveRunner);
    this.retryPreserves = this.preserveRunner.retry.bind(this.preserveRunner);
    this.preservePersistence = new PreservePersistenceService(this.context, this.preserveRunner);
    this.checkpoint = new PersistenceCheckpointService(this.context);
    this.maintenance = new PersistenceMaintenanceService(this.context);
    this.restoreService = new PersistenceRestoreService(this.maintenance, this.context);
    this.getCheckpointOwned = this.context.getCheckpointOwned.bind(this.context);
    this.preserve = this.preservePersistence.preserve.bind(this.preservePersistence);
    this.preserveByPolicy = this.preservePersistence.preserveByPolicy.bind(this.preservePersistence);
    this.verify = this.checkpoint.verify.bind(this.checkpoint);
    this.sourceResolved = this.checkpoint.sourceResolved.bind(this.checkpoint);
    this.publishOutput = this.checkpoint.publishOutput.bind(this.checkpoint);
    this.storageInventory = this.maintenance.storageInventory.bind(this.maintenance);
    this.pruneExpired = this.maintenance.pruneExpired.bind(this.maintenance);
    this.delete = this.maintenance.delete.bind(this.maintenance);
    this.restore = this.restoreService.restore.bind(this.restoreService);
  }
  readonly reconcileCheckpointOperation: ReturnType<typeof createPersistenceTransferRecovery>;
  readonly drain: PersistenceContext["drain"];
  readonly purge: PersistencePurgeService["purge"];
  readonly retryPurges: PersistencePurgeService["retry"];
  readonly retryPreserves: PersistencePreserveRunner["retry"];
  private readonly restoreService: PersistenceRestoreService;

  private readonly maintenance: PersistenceMaintenanceService;

  private readonly checkpoint: PersistenceCheckpointService;

  private readonly preservePersistence: PreservePersistenceService;

  private readonly preserveRunner: PersistencePreserveRunner;

  private readonly context: PersistenceContext;

  readonly getCheckpointOwned: PersistenceContext["getCheckpointOwned"];

  readonly preserve: PreservePersistenceService["preserve"];

  readonly preserveByPolicy: PreservePersistenceService["preserveByPolicy"];

  readonly verify: PersistenceCheckpointService["verify"];

  readonly sourceResolved: PersistenceCheckpointService["sourceResolved"];

  readonly publishOutput: PersistenceCheckpointService["publishOutput"];

  readonly storageInventory: PersistenceMaintenanceService["storageInventory"];

  readonly pruneExpired: PersistenceMaintenanceService["pruneExpired"];

  readonly delete: PersistenceMaintenanceService["delete"];

  readonly restore: PersistenceRestoreService["restore"];
}

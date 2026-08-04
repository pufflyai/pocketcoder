export {
	DEFAULT_PERSISTENCE_LIMITS,
	type PersistenceLimits,
	toCheckpointResource,
	toOperationResource,
} from "./persistence-base";

import { PersistenceCheckpointService } from "./persistence-checkpoints";

export class PersistenceService extends PersistenceCheckpointService {}

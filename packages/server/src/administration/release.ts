import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";
import { controllerDataFormat } from "@pstdio/pocketcoder-db/engine";

export const controllerRelease = { data: controllerDataFormat, agentProtocol: PROTOCOL_VERSION };

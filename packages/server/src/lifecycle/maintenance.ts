// Exposes same-process maintenance without extending tenant machine-key authority.
export { startProcessControl } from "./process-control";
export { requestProcessQuiescence } from "./process-control-client";
export { runControlledPocketCoderServerUntilSignal } from "./process-control-lifecycle";

import type { ExecSpec, ServerFrame } from "@pstdio/pocketcoder-contracts";
import type { SetupCompletion } from "../bootstrap/setup-completion";
import type { WorkspaceCredentials } from "../credentials/workspace-credentials";
import type { SupervisorScreenshots } from "../displays/screenshots";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import type { SupervisorProxy } from "../proxy/supervisor-proxy";
import type { SupervisorTransfers } from "./supervisor-transfers";

export async function handleControlFrame(
  frame: ServerFrame,
  deps: {
    credentials: WorkspaceCredentials;
    setupCompletion: SetupCompletion;
    screenshots: SupervisorScreenshots;
    proxy: SupervisorProxy;
    transfers: SupervisorTransfers;
    logs: SupervisorLogs;
    exec: ExecSpec | null;
    stopping: boolean;
  },
) {
  switch (frame.type) {
    case "credential_renewed":
      await deps.credentials.renewed(frame.payload);
      return true;
    case "credential_installed_ack":
      deps.credentials.confirmed(frame.payload);
      return true;
    case "setup_complete_ack":
      deps.setupCompletion.acknowledge(frame.payload.request_id);
      return true;
    case "screenshot_capture":
      if (!deps.stopping)
        void deps.screenshots.capture(frame.payload).catch(() => deps.logs.log("Screenshot capture failed."));
      return true;
    case "preview_socket":
    case "proxy_request":
    case "proxy_stream_ack":
    case "proxy_stream_cancel":
      await deps.proxy.handle(frame);
      return true;
    case "prepare_checkpoint_archive":
      if (deps.exec)
        await deps.transfers.prepare(frame.payload, deps.exec).catch((error) => deps.logs.log(String(error)));
      return true;
    case "checkpoint_upload":
      await deps.transfers.upload(frame.payload).catch((error) => deps.logs.log(String(error)));
      return true;
    default:
      return false;
  }
}

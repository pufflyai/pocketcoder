import { AdministrationApi } from "./resources/admin/admin";
import { AttachmentsApi } from "./resources/attachments/attachments";
import { ManagedAuthorityApi } from "./resources/budgets/budgets";
import { CheckpointsApi, OperationsApi } from "./resources/checkpoints/checkpoints";
import { ConversationsApi } from "./resources/conversations/conversations";
import { WorkspaceRequestsApi } from "./resources/conversations/requests";
import { LogsApi, NetworkEventsApi, OutputsApi } from "./resources/diagnostics/diagnostics";
import { DisplaysApi } from "./resources/displays/displays";
import { KeysApi, RecoveryApi } from "./resources/keys/keys";
import { PreviewsApi } from "./resources/previews/previews";
import { PrincipalsApi } from "./resources/principals/principals";
import { SecretsApi } from "./resources/secrets/secrets";
import { SessionFilesApi } from "./resources/sessions/files";
import { SessionRequestsApi } from "./resources/sessions/requests";
import { SessionsApi } from "./resources/sessions/sessions";
import { TemplatesApi } from "./resources/templates/templates";
import { TerminalsApi } from "./resources/terminals/terminals";
import { WorkspacesApi } from "./resources/workspaces/workspaces";
import { type PocketCoderClientConfig, PocketCoderTransport } from "./transport/transport";

export class PocketCoderClient {
  private readonly transport: PocketCoderTransport;
  readonly secrets: SecretsApi;
  readonly templates: TemplatesApi;
  readonly workspaces: WorkspacesApi;
  readonly previews: PreviewsApi;
  readonly displays: DisplaysApi;
  readonly attachments: AttachmentsApi;
  readonly conversations: ConversationsApi;
  readonly workspaceRequests: WorkspaceRequestsApi;
  readonly checkpoints: CheckpointsApi;
  readonly operations: OperationsApi;
  readonly logs: LogsApi;
  readonly networkEvents: NetworkEventsApi;
  readonly outputs: OutputsApi;
  readonly administration: AdministrationApi;
  readonly terminals: TerminalsApi;
  readonly principals: PrincipalsApi;
  readonly keys: KeysApi;
  readonly recovery: RecoveryApi;
  // Managed sessions: the application-facing runtime boundary.
  readonly sessions: SessionsApi;
  readonly requests: SessionRequestsApi;
  readonly files: SessionFilesApi;
  readonly authority: ManagedAuthorityApi;

  constructor(config: PocketCoderClientConfig, fetchImpl: typeof fetch = fetch) {
    this.transport = new PocketCoderTransport(config, fetchImpl);
    this.secrets = new SecretsApi(this.transport);
    this.templates = new TemplatesApi(this.transport);
    this.workspaces = new WorkspacesApi(this.transport);
    this.previews = new PreviewsApi(this.transport);
    this.displays = new DisplaysApi(this.transport);
    this.attachments = new AttachmentsApi(this.transport);
    this.conversations = new ConversationsApi(this.transport);
    this.workspaceRequests = new WorkspaceRequestsApi(this.transport);
    this.checkpoints = new CheckpointsApi(this.transport);
    this.operations = new OperationsApi(this.transport);
    this.logs = new LogsApi(this.transport);
    this.networkEvents = new NetworkEventsApi(this.transport);
    this.outputs = new OutputsApi(this.transport);
    this.administration = new AdministrationApi(this.transport);
    this.terminals = new TerminalsApi(this.transport);
    this.principals = new PrincipalsApi(this.transport);
    this.keys = new KeysApi(this.transport);
    this.recovery = new RecoveryApi(this.transport);
    this.sessions = new SessionsApi(this.transport);
    this.requests = new SessionRequestsApi(this.transport);
    this.files = new SessionFilesApi(this.transport);
    this.authority = new ManagedAuthorityApi(this.transport);
  }

  raw(path: string, init: RequestInit = {}) {
    return this.transport.raw(path, init);
  }
}

export type { PocketCoderClientConfig } from "./transport/transport";

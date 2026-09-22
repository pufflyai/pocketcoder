import { AdministrationApi } from "./resources/admin/admin";
import { AgentApi, AttachmentsApi } from "./resources/attachments/attachments";
import { CheckpointsApi, OperationsApi } from "./resources/checkpoints/checkpoints";
import { ConversationsApi } from "./resources/conversations/conversations";
import { LogsApi, NetworkEventsApi, OutputsApi } from "./resources/diagnostics/diagnostics";
import { KeysApi, RecoveryApi } from "./resources/keys/keys";
import { TemplatesApi } from "./resources/templates/templates";
import { TerminalsApi } from "./resources/terminals/terminals";
import { WorkspacesApi } from "./resources/workspaces/workspaces";
import { type PocketCoderClientConfig, PocketCoderTransport } from "./transport/transport";

export class PocketCoderClient {
  private readonly transport: PocketCoderTransport;
  readonly templates: TemplatesApi;
  readonly workspaces: WorkspacesApi;
  readonly attachments: AttachmentsApi;
  readonly agent: AgentApi;
  readonly conversations: ConversationsApi;
  readonly checkpoints: CheckpointsApi;
  readonly operations: OperationsApi;
  readonly logs: LogsApi;
  readonly networkEvents: NetworkEventsApi;
  readonly outputs: OutputsApi;
  readonly administration: AdministrationApi;
  readonly terminals: TerminalsApi;
  readonly keys: KeysApi;
  readonly recovery: RecoveryApi;

  constructor(config: PocketCoderClientConfig, fetchImpl: typeof fetch = fetch) {
    this.transport = new PocketCoderTransport(config, fetchImpl);
    this.templates = new TemplatesApi(this.transport);
    this.workspaces = new WorkspacesApi(this.transport);
    this.attachments = new AttachmentsApi(this.transport);
    this.agent = new AgentApi(this.transport, this.workspaces);
    this.conversations = new ConversationsApi(this.transport);
    this.checkpoints = new CheckpointsApi(this.transport);
    this.operations = new OperationsApi(this.transport);
    this.logs = new LogsApi(this.transport);
    this.networkEvents = new NetworkEventsApi(this.transport);
    this.outputs = new OutputsApi(this.transport);
    this.administration = new AdministrationApi(this.transport);
    this.terminals = new TerminalsApi(this.transport);
    this.keys = new KeysApi(this.transport);
    this.recovery = new RecoveryApi(this.transport);
  }

  raw(path: string, init: RequestInit = {}) {
    return this.transport.raw(path, init);
  }
}

export type { PocketCoderClientConfig } from "./transport/transport";

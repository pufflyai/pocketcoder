import { AdministrationApi } from "./admin";
import { AgentApi, AttachmentsApi } from "./attachments";
import { CheckpointsApi, OperationsApi } from "./checkpoints";
import { ConversationsApi } from "./conversations";
import { LogsApi, NetworkEventsApi, OutputsApi } from "./diagnostics";
import { TemplatesApi } from "./templates";
import { TerminalsApi } from "./terminals";
import { type PocketCoderClientConfig, PocketCoderTransport } from "./transport";
import { WorkspacesApi } from "./workspaces";

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

  constructor(config: PocketCoderClientConfig, fetchImpl: typeof fetch = fetch) {
    this.transport = new PocketCoderTransport(config, fetchImpl);
    this.templates = new TemplatesApi(this.transport);
    this.workspaces = new WorkspacesApi(this.transport);
    this.attachments = new AttachmentsApi(this.transport);
    this.agent = new AgentApi(this.transport);
    this.conversations = new ConversationsApi(this.transport);
    this.checkpoints = new CheckpointsApi(this.transport);
    this.operations = new OperationsApi(this.transport);
    this.logs = new LogsApi(this.transport);
    this.networkEvents = new NetworkEventsApi(this.transport);
    this.outputs = new OutputsApi(this.transport);
    this.administration = new AdministrationApi(this.transport);
    this.terminals = new TerminalsApi(this.transport);
  }

  raw(path: string, init: RequestInit = {}) {
    return this.transport.raw(path, init);
  }
}

export type { PocketCoderClientConfig } from "./transport";

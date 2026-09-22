import type { Store } from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryAuthStore } from "./modules/auth/memory-store-auth";
import { MemoryConversationStore } from "./modules/conversations/memory-store-conversations";
import { MemoryLogStore } from "./modules/logs/memory-store-logs";
import { MemoryOutboxStore } from "./modules/outbox/memory-store-outbox";
import { createContentPurge } from "./modules/persistence/memory-store-content";
import { MemoryOperationStore } from "./modules/persistence/memory-store-operations";
import { MemoryPersistenceStore } from "./modules/persistence/memory-store-persistence";
import { MemoryTemplateStore } from "./modules/templates/memory-store-templates";
import { MemoryTerminalStore } from "./modules/terminals/memory-store-terminals";
import { MemoryWarmPoolStore } from "./modules/warm-pools/memory-store-warm-pools";
import { MemoryAdmissionStore } from "./modules/workspaces/memory-store-admission";
import { MemoryWorkspaceStore } from "./modules/workspaces/memory-store-workspaces";
import { MemoryState } from "./state/memory-store-base";

export class MemoryStore implements Store {
  constructor() {
    this.context = new MemoryState();
    const content = createContentPurge(this.context);
    this.listWorkspaceStorage = content.listWorkspaceStorage;
    this.purgeWorkspaceContent = content.purgeWorkspaceContent;
    this.persistence = new MemoryPersistenceStore(this.context);
    this.operation = new MemoryOperationStore(this.context);
    this.template = new MemoryTemplateStore(this.context);
    this.workspace = new MemoryWorkspaceStore(this.context);
    this.auth = new MemoryAuthStore(this.context);
    this.warmPool = new MemoryWarmPoolStore(this.context);
    this.admission = new MemoryAdmissionStore(this.context);
    this.terminal = new MemoryTerminalStore(this.context);
    this.log = new MemoryLogStore(this.context);
    this.conversation = new MemoryConversationStore(this.context);
    this.outbox = new MemoryOutboxStore(this.context);
    this.init = this.context.init.bind(this.context);
    this.acquireCoordinatorLease = this.context.acquireCoordinatorLease.bind(this.context);
    this.close = this.context.close.bind(this.context);
    this.insertWorkspaceStorage = this.persistence.insertWorkspaceStorage.bind(this.persistence);
    this.getWorkspaceStorage = this.persistence.getWorkspaceStorage.bind(this.persistence);
    this.getStorage = this.persistence.getStorage.bind(this.persistence);
    this.updateWorkspaceStorage = this.persistence.updateWorkspaceStorage.bind(this.persistence);
    this.insertCheckpoint = this.persistence.insertCheckpoint.bind(this.persistence);
    this.getCheckpoint = this.persistence.getCheckpoint.bind(this.persistence);
    this.listCheckpoints = this.persistence.listCheckpoints.bind(this.persistence);
    this.updateCheckpoint = this.persistence.updateCheckpoint.bind(this.persistence);
    this.insertOperation = this.operation.insertOperation.bind(this.operation);
    this.getOperation = this.operation.getOperation.bind(this.operation);
    this.getOperationByIdempotency = this.operation.getOperationByIdempotency.bind(this.operation);
    this.listIncompleteOperations = this.operation.listIncompleteOperations.bind(this.operation);
    this.updateOperation = this.operation.updateOperation.bind(this.operation);
    this.checkpointUsage = this.operation.checkpointUsage.bind(this.operation);
    this.countIncompleteOperations = this.operation.countIncompleteOperations.bind(this.operation);
    this.appendOutput = this.operation.appendOutput.bind(this.operation);
    this.listOutputs = this.operation.listOutputs.bind(this.operation);
    this.upsertTemplate = this.template.upsertTemplate.bind(this.template);
    this.listTemplates = this.template.listTemplates.bind(this.template);
    this.getTemplate = this.template.getTemplate.bind(this.template);
    this.setTemplateStatus = this.template.setTemplateStatus.bind(this.template);
    this.insertWorkspace = this.workspace.insertWorkspace.bind(this.workspace);
    this.getWorkspaceByIdempotency = this.workspace.getWorkspaceByIdempotency.bind(this.workspace);
    this.getWorkspace = this.workspace.getWorkspace.bind(this.workspace);
    this.listWorkspaces = this.workspace.listWorkspaces.bind(this.workspace);
    this.createPrincipal = this.auth.createPrincipal.bind(this.auth);
    this.getPrincipalByName = this.auth.getPrincipalByName.bind(this.auth);
    this.listPrincipals = this.auth.listPrincipals.bind(this.auth);
    this.updatePrincipal = this.auth.updatePrincipal.bind(this.auth);
    this.setPrincipalDisabled = this.auth.setPrincipalDisabled.bind(this.auth);
    this.getPrincipal = this.auth.getPrincipal.bind(this.auth);
    this.issueMachineKey = this.auth.issueMachineKey.bind(this.auth);
    this.listMachineKeys = this.auth.listMachineKeys.bind(this.auth);
    this.revokePrincipalKeys = this.auth.revokePrincipalKeys.bind(this.auth);
    this.insertMachineKey = this.auth.insertMachineKey.bind(this.auth);
    this.getMachineKeyWithPrincipal = this.auth.getMachineKeyWithPrincipal.bind(this.auth);
    this.revokeMachineKey = this.auth.revokeMachineKey.bind(this.auth);
    this.touchMachineKey = this.auth.touchMachineKey.bind(this.auth);
    this.insertWarmPoolRuntime = this.warmPool.insertWarmPoolRuntime.bind(this.warmPool);
    this.getWarmPoolRuntime = this.warmPool.getWarmPoolRuntime.bind(this.warmPool);
    this.listWarmPoolRuntimes = this.warmPool.listWarmPoolRuntimes.bind(this.warmPool);
    this.updateWarmPoolRuntime = this.warmPool.updateWarmPoolRuntime.bind(this.warmPool);
    this.claimWarmPoolRuntime = this.warmPool.claimWarmPoolRuntime.bind(this.warmPool);
    this.listQueuedHeads = this.admission.listQueuedHeads.bind(this.admission);
    this.listNonterminal = this.admission.listNonterminal.bind(this.admission);
    this.countActive = this.admission.countActive.bind(this.admission);
    this.countQueued = this.admission.countQueued.bind(this.admission);
    this.claimWorkspaceAdmission = this.admission.claimWorkspaceAdmission.bind(this.admission);
    this.updateWorkspace = this.admission.updateWorkspace.bind(this.admission);
    this.waitForWorkspaceChange = this.admission.waitForWorkspaceChange.bind(this.admission);
    this.transition = this.admission.transition.bind(this.admission);
    this.listStateHistory = this.admission.listStateHistory.bind(this.admission);
    this.openTerminalSession = this.terminal.openTerminalSession.bind(this.terminal);
    this.getTerminalSession = this.terminal.getTerminalSession.bind(this.terminal);
    this.closeTerminalSession = this.terminal.closeTerminalSession.bind(this.terminal);
    this.listTerminalSessions = this.terminal.listTerminalSessions.bind(this.terminal);
    this.appendLogs = this.log.appendLogs.bind(this.log);
    this.readLogs = this.log.readLogs.bind(this.log);
    this.readLogTail = this.log.readLogTail.bind(this.log);
    this.appendNetworkEvents = this.log.appendNetworkEvents.bind(this.log);
    this.readNetworkEvents = this.log.readNetworkEvents.bind(this.log);
    this.appendConversationMessage = this.conversation.appendConversationMessage.bind(this.conversation);
    this.readConversation = this.conversation.readConversation.bind(this.conversation);
    this.getConversationState = this.conversation.getConversationState.bind(this.conversation);
    this.setConversationExpiry = this.conversation.setConversationExpiry.bind(this.conversation);
    this.deleteConversation = this.conversation.deleteConversation.bind(this.conversation);
    this.pruneExpiredConversations = this.conversation.pruneExpiredConversations.bind(this.conversation);
    this.claimDueEvents = this.outbox.claimDueEvents.bind(this.outbox);
    this.markEventDelivered = this.outbox.markEventDelivered.bind(this.outbox);
    this.markEventFailed = this.outbox.markEventFailed.bind(this.outbox);
    this.appendEvent = this.outbox.appendEvent.bind(this.outbox);
  }
  private readonly outbox: MemoryOutboxStore;

  private readonly conversation: MemoryConversationStore;

  private readonly log: MemoryLogStore;

  private readonly terminal: MemoryTerminalStore;

  private readonly admission: MemoryAdmissionStore;

  private readonly warmPool: MemoryWarmPoolStore;

  private readonly auth: MemoryAuthStore;

  private readonly workspace: MemoryWorkspaceStore;

  private readonly template: MemoryTemplateStore;

  private readonly operation: MemoryOperationStore;

  private readonly persistence: MemoryPersistenceStore;

  private readonly context: MemoryState;

  readonly listWorkspaceStorage: Store["listWorkspaceStorage"];
  readonly purgeWorkspaceContent: Store["purgeWorkspaceContent"];
  readonly init: MemoryState["init"];

  readonly acquireCoordinatorLease: MemoryState["acquireCoordinatorLease"];

  readonly close: MemoryState["close"];

  readonly insertWorkspaceStorage: MemoryPersistenceStore["insertWorkspaceStorage"];

  readonly getWorkspaceStorage: MemoryPersistenceStore["getWorkspaceStorage"];

  readonly getStorage: MemoryPersistenceStore["getStorage"];

  readonly updateWorkspaceStorage: MemoryPersistenceStore["updateWorkspaceStorage"];

  readonly insertCheckpoint: MemoryPersistenceStore["insertCheckpoint"];

  readonly getCheckpoint: MemoryPersistenceStore["getCheckpoint"];

  readonly listCheckpoints: MemoryPersistenceStore["listCheckpoints"];

  readonly updateCheckpoint: MemoryPersistenceStore["updateCheckpoint"];

  readonly insertOperation: MemoryOperationStore["insertOperation"];

  readonly getOperation: MemoryOperationStore["getOperation"];

  readonly getOperationByIdempotency: MemoryOperationStore["getOperationByIdempotency"];

  readonly listIncompleteOperations: MemoryOperationStore["listIncompleteOperations"];

  readonly updateOperation: MemoryOperationStore["updateOperation"];

  readonly checkpointUsage: MemoryOperationStore["checkpointUsage"];

  readonly countIncompleteOperations: MemoryOperationStore["countIncompleteOperations"];

  readonly appendOutput: MemoryOperationStore["appendOutput"];

  readonly listOutputs: MemoryOperationStore["listOutputs"];

  readonly upsertTemplate: MemoryTemplateStore["upsertTemplate"];

  readonly listTemplates: MemoryTemplateStore["listTemplates"];

  readonly getTemplate: MemoryTemplateStore["getTemplate"];

  readonly setTemplateStatus: MemoryTemplateStore["setTemplateStatus"];

  readonly insertWorkspace: MemoryWorkspaceStore["insertWorkspace"];

  readonly getWorkspaceByIdempotency: MemoryWorkspaceStore["getWorkspaceByIdempotency"];

  readonly getWorkspace: MemoryWorkspaceStore["getWorkspace"];

  readonly listWorkspaces: MemoryWorkspaceStore["listWorkspaces"];

  readonly createPrincipal: MemoryAuthStore["createPrincipal"];

  readonly getPrincipalByName: MemoryAuthStore["getPrincipalByName"];

  readonly listPrincipals: MemoryAuthStore["listPrincipals"];

  readonly updatePrincipal: MemoryAuthStore["updatePrincipal"];

  readonly setPrincipalDisabled: MemoryAuthStore["setPrincipalDisabled"];

  readonly getPrincipal: Store["getPrincipal"];
  readonly issueMachineKey: Store["issueMachineKey"];
  readonly listMachineKeys: Store["listMachineKeys"];
  readonly revokePrincipalKeys: Store["revokePrincipalKeys"];
  readonly insertMachineKey: MemoryAuthStore["insertMachineKey"];

  readonly getMachineKeyWithPrincipal: MemoryAuthStore["getMachineKeyWithPrincipal"];

  readonly revokeMachineKey: MemoryAuthStore["revokeMachineKey"];

  readonly touchMachineKey: MemoryAuthStore["touchMachineKey"];

  readonly insertWarmPoolRuntime: MemoryWarmPoolStore["insertWarmPoolRuntime"];

  readonly getWarmPoolRuntime: MemoryWarmPoolStore["getWarmPoolRuntime"];

  readonly listWarmPoolRuntimes: MemoryWarmPoolStore["listWarmPoolRuntimes"];

  readonly updateWarmPoolRuntime: MemoryWarmPoolStore["updateWarmPoolRuntime"];

  readonly claimWarmPoolRuntime: MemoryWarmPoolStore["claimWarmPoolRuntime"];

  readonly listQueuedHeads: MemoryAdmissionStore["listQueuedHeads"];

  readonly listNonterminal: MemoryAdmissionStore["listNonterminal"];

  readonly countActive: MemoryAdmissionStore["countActive"];

  readonly countQueued: MemoryAdmissionStore["countQueued"];

  readonly claimWorkspaceAdmission: MemoryAdmissionStore["claimWorkspaceAdmission"];

  readonly updateWorkspace: MemoryAdmissionStore["updateWorkspace"];

  readonly waitForWorkspaceChange: MemoryAdmissionStore["waitForWorkspaceChange"];

  readonly transition: MemoryAdmissionStore["transition"];

  readonly listStateHistory: MemoryAdmissionStore["listStateHistory"];

  readonly openTerminalSession: MemoryTerminalStore["openTerminalSession"];

  readonly getTerminalSession: MemoryTerminalStore["getTerminalSession"];

  readonly closeTerminalSession: MemoryTerminalStore["closeTerminalSession"];

  readonly listTerminalSessions: MemoryTerminalStore["listTerminalSessions"];

  readonly appendLogs: MemoryLogStore["appendLogs"];

  readonly readLogs: MemoryLogStore["readLogs"];

  readonly readLogTail: MemoryLogStore["readLogTail"];

  readonly appendNetworkEvents: MemoryLogStore["appendNetworkEvents"];

  readonly readNetworkEvents: MemoryLogStore["readNetworkEvents"];

  readonly appendConversationMessage: MemoryConversationStore["appendConversationMessage"];

  readonly readConversation: MemoryConversationStore["readConversation"];

  readonly getConversationState: MemoryConversationStore["getConversationState"];

  readonly setConversationExpiry: MemoryConversationStore["setConversationExpiry"];

  readonly deleteConversation: MemoryConversationStore["deleteConversation"];

  readonly pruneExpiredConversations: MemoryConversationStore["pruneExpiredConversations"];

  readonly claimDueEvents: MemoryOutboxStore["claimDueEvents"];

  readonly markEventDelivered: MemoryOutboxStore["markEventDelivered"];

  readonly markEventFailed: MemoryOutboxStore["markEventFailed"];

  readonly appendEvent: MemoryOutboxStore["appendEvent"];
}

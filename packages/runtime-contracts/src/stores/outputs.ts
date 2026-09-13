export interface WorkspaceOutputRow {
  workspaceId: string;
  seq: number;
  name: string;
  value: unknown;
  occurredAt: Date;
}

export interface OutputStore {
  appendOutput(row: WorkspaceOutputRow): Promise<WorkspaceOutputRow>;
  listOutputs(workspaceId: string): Promise<WorkspaceOutputRow[]>;
}

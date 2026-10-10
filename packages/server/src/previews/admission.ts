import { ApiError } from "@pstdio/pocketcoder-contracts";

export class ViewAdmission {
  private readonly active = new Set<{ workspace: string; name: string }>();

  reserve(workspace: string, name: string) {
    const entries = [...this.active];
    if (
      this.active.size >= 128 ||
      entries.filter((entry) => entry.workspace === workspace).length >= 64 ||
      entries.filter((entry) => entry.workspace === workspace && entry.name === name).length >= 32
    ) {
      throw new ApiError("operation.conflict", "View stream limit reached.");
    }
    const entry = { workspace, name };
    this.active.add(entry);
    return () => {
      this.active.delete(entry);
    };
  }
}

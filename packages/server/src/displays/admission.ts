import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ViewAdmission } from "../previews/admission";

export class DisplayAdmission {
  private readonly active = new Map<string, { viewers: number; control: boolean }>();
  constructor(private readonly views: ViewAdmission) {}

  reserve(workspaceId: string, control: boolean) {
    const current = this.active.get(workspaceId) ?? { viewers: 0, control: false };
    if (current.viewers >= 5 || (control && current.control)) {
      throw new ApiError("operation.conflict", "Display viewer or control limit reached.");
    }
    const release = this.views.reserve(workspaceId, "display");
    current.viewers++;
    if (control) current.control = true;
    this.active.set(workspaceId, current);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      current.viewers--;
      if (control) current.control = false;
      if (!current.viewers) this.active.delete(workspaceId);
    };
  }
}

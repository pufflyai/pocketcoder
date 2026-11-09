import type { managedSchemas } from "./schemas";

type Shape = keyof typeof managedSchemas | "bytes";
const route = (
  method: "get" | "post" | "put",
  path: string,
  response: Shape | "empty",
  body?: Shape,
  shipped = false,
) => ({
  method,
  path,
  response,
  body,
  shipped,
});
const sessions = "/v1/sessions/{sessionId}";
const requests = `${sessions}/requests`;
const budgets = "/v1/budget-scopes/{scopeId}";

// The implementation marker follows the owning server routes; remaining operations are designs.
export const managedRoutes = [
  route("put", `${budgets}/grant`, "empty", "BudgetScopeGrant", true),
  route("put", "/v1/credential-bindings/{bindingId}", "empty", "CredentialBinding", true),
  route("put", "/v1/execution-profiles/{profileId}/revisions/{revision}", "ExecutionProfile", "ExecutionProfile", true),
  route("post", "/v1/sessions", "Session", "SessionCreate", true),
  route("get", sessions, "Session", undefined, true),
  route("post", `${sessions}/resume`, "Session", undefined, true),
  route("post", requests, "Request", "RequestInput", true),
  route("get", `${requests}/{requestId}`, "Request", undefined, true),
  route("post", `${requests}/{requestId}/cancel`, "CancelReceipt", "CancelCommand", true),
  route("post", `${sessions}/close`, "CancelReceipt", "CancelCommand", true),
  route("get", `${sessions}/events`, "RuntimeEvent", undefined, true),
  route("get", `${sessions}/history`, "HistoryPage", undefined, true),
  route("post", `${sessions}/inputs`, "InputObject", "InputUpload", true),
  route("put", `${sessions}/inputs/{inputId}/content`, "InputObject", "bytes", true),
  route("get", `${sessions}/inputs/{inputId}`, "InputObject", undefined, true),
  route("get", `${requests}/{requestId}/collection`, "CollectionResult", undefined, true),
  route("get", `${sessions}/exports`, "ExportPage", undefined, true),
  route("get", `${sessions}/exports/{exportId}/content`, "bytes", undefined, true),
  route("put", `${budgets}/policy`, "BudgetPolicy", "BudgetPolicyWrite", true),
  route("get", `${budgets}/policy`, "BudgetPolicy", undefined, true),
  route("get", `${budgets}/usage`, "BudgetUsage", undefined, true),
];

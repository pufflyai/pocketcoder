import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ModelGatewayConfig } from "./config";

type Json = Record<string, unknown>;

// Only these fields are forwarded. Anything else fails closed: an unknown field could change
// what the provider generates or bills, and it was never counted or qualified.
const ALLOWED_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_output_tokens",
  "temperature",
  "top_p",
  "stream",
  "store",
  "text",
  "reasoning",
]);
// Named separately so the caller learns why the first profile refuses them.
const STATEFUL_FIELDS = ["previous_response_id", "conversation", "background", "prompt", "include"];
const COUNTED_FIELDS = ["input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text"];
const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);
const TEXT_PARTS = new Set(["input_text", "output_text"]);

export interface GatewayRequest {
  logicalModel: string;
  providerModel: string;
  minOutputTokens: number;
  requestedOutputTokens: number | null;
  stream: boolean;
  // The exact provider payload, without the output cap that the reservation decides.
  frozen: Json;
  // The payload sent to the provider count endpoint for this frozen request.
  count: Json;
}

const unsupported = (message: string) => new ApiError("relay.route_not_allowed", message);
const invalid = (message: string) => new ApiError("validation.invalid", message);
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textContent(content: unknown) {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) throw invalid("Message content must be text.");
  for (const part of content) {
    if (!isObject(part) || !TEXT_PARTS.has(String(part.type)) || typeof part.text !== "string")
      throw unsupported("Only text message parts are supported.");
    for (const key of Object.keys(part))
      if (!["type", "text", "annotations"].includes(key)) throw unsupported("Only text message parts are supported.");
  }
}

function inputItem(item: unknown) {
  if (!isObject(item)) throw invalid("Input items must be objects.");
  const type = item.type ?? "message";
  if (type === "message") {
    if (!MESSAGE_ROLES.has(String(item.role))) throw invalid("Message role is not supported.");
    for (const key of Object.keys(item))
      if (!["type", "role", "content", "id", "status"].includes(key)) throw unsupported("Unknown message field.");
    return textContent(item.content);
  }
  if (type === "function_call") {
    if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
      throw invalid("A function call needs call_id, name and arguments.");
    return;
  }
  if (type === "function_call_output") {
    if (typeof item.call_id !== "string" || typeof item.output !== "string")
      throw unsupported("Function output must be text.");
    return;
  }
  throw unsupported("Only message and function tool items are supported.");
}

function tools(value: unknown) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw invalid("Tools must be a list.");
  for (const tool of value) {
    // Provider-hosted tools (search, files, code, MCP) act and bill outside this gateway's counting.
    if (!isObject(tool) || tool.type !== "function" || typeof tool.name !== "string")
      throw unsupported("Only custom function tools are supported.");
  }
}

function toolChoice(value: unknown) {
  if (value === undefined || value === "auto" || value === "none" || value === "required") return;
  if (isObject(value) && value.type === "function" && typeof value.name === "string") return;
  throw unsupported("Only function tool choices are supported.");
}

function outputCap(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw invalid("max_output_tokens must be a positive integer.");
  return value;
}

function fields(body: Json) {
  for (const field of STATEFUL_FIELDS)
    if (field in body) throw unsupported(`${field} is not supported by the managed gateway.`);
  for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) throw unsupported(`${key} is not supported.`);
  if (body.store !== undefined && body.store !== false)
    throw unsupported("Provider response storage is not enabled for this gateway.");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid("stream must be a boolean.");
  if (body.instructions !== undefined && typeof body.instructions !== "string")
    throw invalid("Instructions must be text.");
  if (body.reasoning !== undefined && !isObject(body.reasoning)) throw invalid("reasoning must be an object.");
}

function input(value: unknown) {
  if (typeof value === "string" && value) return;
  if (Array.isArray(value) && value.length) return value.forEach(inputItem);
  throw invalid("A complete explicit input is required.");
}

function textFormat(value: unknown) {
  if (value === undefined) return;
  const format = isObject(value) && isObject(value.format) ? value.format.type : "text";
  if (!isObject(value) || !["text", "json_schema", "json_object"].includes(String(format)))
    throw unsupported("Only text output is supported.");
}

function selectedModel(value: unknown, allowedModels: string[], config: ModelGatewayConfig) {
  const model = typeof value === "string" ? config.models[value] : undefined;
  if (typeof value !== "string" || !model || !allowedModels.includes(value))
    throw new ApiError("auth.missing_scope", "This model is not allowed for the session.");
  return { logicalModel: value, ...model };
}

export function gatewayRequest(body: unknown, allowedModels: string[], config: ModelGatewayConfig): GatewayRequest {
  if (!isObject(body)) throw invalid("The request body must be a JSON object.");
  fields(body);
  const model = selectedModel(body.model, allowedModels, config);
  input(body.input);
  tools(body.tools);
  toolChoice(body.tool_choice);
  textFormat(body.text);
  const requestedOutputTokens = outputCap(body.max_output_tokens);
  if (requestedOutputTokens !== null && requestedOutputTokens < model.minOutputTokens)
    throw unsupported("max_output_tokens is below the qualified minimum for this model.");
  const { max_output_tokens: _cap, ...rest } = body;
  const frozen: Json = { ...rest, model: model.providerModel, store: false };
  const count: Json = { model: model.providerModel };
  for (const field of COUNTED_FIELDS) if (body[field] !== undefined) count[field] = body[field];
  return {
    logicalModel: model.logicalModel,
    providerModel: model.providerModel,
    minOutputTokens: model.minOutputTokens,
    requestedOutputTokens,
    stream: body.stream === true,
    frozen,
    count,
  };
}

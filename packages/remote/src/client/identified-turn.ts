import { type ConversationFact, ConversationRequestIdentitySchema, canonicalJson } from "@pstdio/pocketcoder-contracts";
import type { ConversationMessageInput, ConversationRequestIdentity } from "@pstdio/pocketcoder-sdk";
import { readAgentApiEvents } from "../stream/agentapi-events";
import { delay } from "./client-helpers";
import { remoteResponseError } from "./remote-request-error";

export interface IdentifiedTurnOptions {
  signal?: AbortSignal;
  attachmentIds?: string[];
  onEvent?: (event: ConversationMessageInput) => void;
}

interface TurnTransport {
  request(path: string, init?: RequestInit): Promise<Response>;
  waitForInput(signal: AbortSignal): Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}

async function openEvents(transport: TurnTransport, signal: AbortSignal, accepted: boolean) {
  const response = await transport.request("/events", { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok) throw await remoteResponseError(response, accepted ? "reply_events" : "initial_events", accepted);
  if (!response.body) throw new Error("AgentAPI events response had no body");
  return response.body;
}

function matchingFact(message: ConversationMessageInput, identity: ConversationRequestIdentity) {
  const envelope = message.identity;
  if (!envelope?.fact || canonicalJson(ConversationRequestIdentitySchema.parse(envelope)) !== canonicalJson(identity))
    return null;
  return { envelope, fact: envelope.fact };
}

interface TurnObservation {
  finalResponse: ConversationMessageInput | null;
  toolOnly: boolean;
}

function applyFact(observed: TurnObservation, message: ConversationMessageInput, fact: ConversationFact) {
  if (
    fact.type === "final_response" &&
    (message.identity?.sequence ?? 0) >= (observed.finalResponse?.identity?.sequence ?? 0)
  ) {
    return { ...observed, finalResponse: message };
  }
  if (fact.type === "tool_only") return { ...observed, toolOnly: true };
  return observed;
}

async function observeTurn(
  transport: TurnTransport,
  initial: ReadableStream<Uint8Array>,
  identity: ConversationRequestIdentity,
  options: IdentifiedTurnOptions,
  signal: AbortSignal,
) {
  let body = initial;
  let observed: TurnObservation = { finalResponse: null, toolOnly: false };
  const revisions = new Map<string, number>();
  while (!signal.aborted) {
    for await (const event of readAgentApiEvents(body, signal)) {
      if (event.event !== "conversation_message") continue;
      const matching = matchingFact(event.data, identity);
      if (!matching) continue;
      const { envelope, fact } = matching;
      if ((revisions.get(envelope.event_id) ?? 0) >= envelope.revision) continue;
      revisions.set(envelope.event_id, envelope.revision);
      options.onEvent?.(event.data);
      observed = applyFact(observed, event.data, fact);
      if (fact.type === "turn_terminal") {
        return { identity, outcome: fact.outcome, ...observed };
      }
    }
    await delay(transport.pollIntervalMs, signal);
    body = await openEvents(transport, signal, true);
  }
  throw signal.reason;
}

// Use only after negotiation with a verified v2 producer. Status and the last
// assistant message cannot establish an explicit final or terminal fact.
export async function sendIdentifiedTurn(
  transport: TurnTransport,
  prompt: string,
  identity: ConversationRequestIdentity,
  options: IdentifiedTurnOptions,
) {
  const context = ConversationRequestIdentitySchema.parse(identity);
  const stopped = new AbortController();
  const timer = setTimeout(
    () => stopped.abort(new Error(`remote agent did not finish within ${transport.timeoutMs}ms`)),
    transport.timeoutMs,
  );
  const signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
  let observing: ReturnType<typeof observeTurn> | undefined;
  try {
    await transport.waitForInput(signal);
    const events = await openEvents(transport, signal, false);
    observing = observeTurn(transport, events, context, options, signal);
    // Attach a rejection handler while prompt acceptance is still in flight.
    void observing.catch(() => {});
    const response = await transport.request("/message", {
      method: "POST",
      body: JSON.stringify({
        type: "user",
        content: prompt,
        identity: context,
        ...(options.attachmentIds?.length ? { attachment_ids: options.attachmentIds } : {}),
      }),
      signal,
    });
    if (!response.ok) throw await remoteResponseError(response, "submit", false);
    return await observing;
  } finally {
    clearTimeout(timer);
    stopped.abort("turn ended");
    await observing?.catch(() => {});
  }
}

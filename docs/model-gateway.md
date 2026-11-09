# Managed model gateway

The model gateway is the only way a managed workspace reaches a model provider.
It checks the session's budget before every model call, sends the call once, and
records the provider's own usage report. Workspaces never hold the provider key.

This page covers the first supported provider route, how counting works, and
what happens when a call is interrupted. Workspace credentials and network
enforcement are described in [runtime credentials](runtime-credentials.md) and
[security](security.md). The budget ledger is described in
[managed runtime](managed-runtime.md#reserve-claim-and-settle).

## Supported route

The first qualified route is the OpenAI Responses API over HTTPS:

- Text input and text output. The input must be complete in the request.
- Custom `function` tools. Each tool continuation is a new, separately admitted call.
- Streaming and non-streaming replies.

The gateway refuses everything else before it counts or reserves anything:

| Refused | Why |
| --- | --- |
| Images, audio, files and URL inputs | Their counting and side effects are not qualified |
| Provider-hosted tools (search, files, code, MCP) | They act and bill outside the gateway |
| `previous_response_id`, `conversation`, `background`, `prompt`, `include` | The provider would hold state the gateway cannot count |
| `store: true` | Provider retention is off for this profile |
| Any field not in the supported list | An unknown field was never counted or qualified |
| A model that is not in both the session profile and the gateway configuration | Model authority comes from the registered profile |
| `max_output_tokens` below the model's qualified minimum | The gateway never rounds a cap up |

Other providers and modalities stay unsupported until they have the same count,
cap and settlement evidence.

## Configure the gateway

Set two environment variables on the controller:

- `POCKETCODER_MODEL_GATEWAY`: a JSON object with the settings below.
- `POCKETCODER_MODEL_GATEWAY_API_KEY`: the standing provider key. It is read from
  its own variable so it never sits inside the JSON settings.

```json
{
  "provider": "openai",
  "upstreamUrl": "https://api.openai.com",
  "providerAccountId": "org-or-project-id",
  "models": {
    "team/default": { "providerModel": "<exact qualified model ID>", "minOutputTokens": 16 }
  },
  "maxRequestBytes": 1048576,
  "maxConcurrentCalls": 32,
  "drainTimeoutMs": 120000
}
```

There are no defaults. Model IDs, limits and the provider URL are deployment
choices. The upstream URL must use HTTPS. Plain HTTP is accepted only for a
loopback test fixture.

- `models` maps the logical model names used in execution profiles to exact provider model IDs.
- `maxRequestBytes` bounds each request body, including requests that are later denied.
- `maxConcurrentCalls` bounds calls in progress, including provider count requests.
  A denial therefore cannot be used for unlimited counting traffic.
- `drainTimeoutMs` bounds how long the gateway keeps reading a reply after the client leaves.

## Workspace access

Workspaces call `POST /v1/model-gateway/v1/responses` on the controller listener
they already use to connect. They authenticate with the credential file described
in [runtime credentials](runtime-credentials.md#model-gateway-credentials) and name
their physical turn in the `x-pocketcoder-turn` header. Managed templates must
use restricted egress that does not allow the provider host; the controller
refuses placement otherwise. A real Docker egress check
(`packages/egress/src/proxy/managed-model-conformance.test.ts`) shows the gateway
route works while the provider host, another port, a redirect and direct IP
traffic fail.

## How one call is admitted

1. The workspace credential resolves to the session, its active request and the
   current physical workspace. Caller-supplied scope, usage, session, request or
   provider URL fields are never trusted.
2. The gateway freezes the provider payload: the mapped provider model, `store: false`
   and the caller's fields. It does not change the counted content afterwards.
3. It asks the provider's input token count endpoint to count that exact payload.
   A missing or malformed count fails closed. No local estimate replaces it.
4. It reserves the input count and the output cap across every budget scope of the
   profile in one transaction. The reservation decides the cap. If the remaining
   allowance cannot cover the qualified minimum, the call is refused.
5. It records a once-only send claim. Only that claim allows the upstream send.
6. It sends the frozen payload once, with `max_output_tokens` set to the reserved cap.
   Automatic retries are off. A new attempt is a new call with a new reservation.

A budget denial returns HTTP 429 with code `budget.exhausted`. The runtime then
ends the accepted request with that reason and keeps its text and history.

## Counting guarantees

- Input is counted by the provider for the exact payload that is sent.
- Cached input stays part of `input_tokens`. Reported output already includes
  reasoning tokens, so they are not added twice.
- Usage is trusted only from the provider's terminal response on the gateway's own
  connection: the JSON reply, or the `response.completed`, `response.incomplete`
  or `response.failed` stream event. The response ID must match the one first seen.
- Workspace code cannot report or settle usage.
- Usage above the reservation is recorded as conflicting evidence. The affected
  scopes stop admitting work until an owner reconciles them.

## Interruptions and restarts

The gateway never infers zero usage from a missing reply.

| What happened | Result |
| --- | --- |
| Count or reservation failed | Nothing was sent. No hold remains. |
| Reserved but never claimed | The hold is released as proved unsent. |
| Claimed, then the network call failed, the provider returned an error, or the stream dropped before usage | The full hold stays as uncertain usage. The call is never sent again. |
| The client disconnected mid-stream | The gateway keeps reading for up to `drainTimeoutMs` so usage can still settle. |
| Trusted usage arrived | The call settles once. A repeated report with the same evidence changes nothing. |

The provider response ID is stored as soon as it is seen, before the reply ends.
With `store: false` the provider does not keep the response, so the ID helps an
operator match provider records during audited reconciliation. It does not let
the gateway recover usage by itself.

After a controller restart, run `reconcileGatewayInvocations` before the gateway
accepts calls. Reserved calls without a send claim are released. Claimed calls
without usage stay uncertain with their full hold. Only trusted provider evidence
through audited owner reconciliation can settle them. Usage reports show the
number of unresolved calls and the oldest one.

## What this does not prove

The local test provider proves the gateway's own behavior: denied calls never
reach generation, nothing is sent twice, and holds survive drops and restarts.
It does not prove that a real provider counts and caps exactly as documented.
Real-provider qualification for each model needs an authorized route and is
recorded separately. Route checks alone do not stop a workspace from calling a
provider directly; the network policy for managed profiles does that.

# 002: Keep final text separate from terminal outcome

Status: Accepted for PC-117 / Onefin O-203.

An assistant can emit answer text before interruption, or finish a turn that only
used tools. AgentAPI stable status and the last assistant message cannot distinguish
these outcomes. A provider may also replay older records on reconnect.

Capable producers supply explicit facts inside the durable v2 message identity.
Keep final-response text separate from a terminal execution outcome. Forward safe
activity facts without estimating absent timings. Consumers retain supplied IDs
and revisions, and never add a final marker to legacy or unclassified history.

Use a separate `sendTurn` adapter path after verified producer negotiation. It
waits for an explicit terminal fact and returns preserved final text with that
outcome. Keep `send` for legacy producers. Supervisor synchronization forwards
identified history by event/revision, while its old stable-tail filter applies
only to legacy records. Storage remains the existing identity JSON envelope.

This keeps transport support independent of installed emission. It requires the
Onefin producer/release work in O-239 before enabling capable turns, and live proof
in O-237 before rollout. No producer capability is advertised by this change.

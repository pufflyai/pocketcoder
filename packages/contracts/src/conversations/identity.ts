import { z } from "zod";

export const ConversationRequestIdentitySchema = z.object({
  schema: z.literal("pocketcoder.conversation/v2"),
  authority: z.enum(["external", "generic"]),
  conversation_id: z.uuid(),
  request_id: z.uuid(),
  turn_id: z.uuid(),
  request_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ConversationRequestIdentity = z.infer<typeof ConversationRequestIdentitySchema>;

export const ConversationRequestReceiptSchema = z.object({
  kind: z.enum(["accepted", "replayed"]),
  identity: ConversationRequestIdentitySchema,
  accepted_at: z.iso.datetime(),
});

export const ConversationMessageIdentitySchema = ConversationRequestIdentitySchema.extend({
  event_id: z.uuid(),
  message_id: z.string().min(1).max(256),
  sequence: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
});
export type ConversationMessageIdentity = z.infer<typeof ConversationMessageIdentitySchema>;

// This describes transport/persistence support. A template must separately
// advertise the identities and progress facts its installed harness emits.
export const ConversationProtocolSupportSchema = z.object({
  schema: z.literal("pocketcoder.conversation/v2"),
  request_identity_authorities: z.array(z.enum(["external", "generic"])),
  producer_capabilities: z.null(),
});

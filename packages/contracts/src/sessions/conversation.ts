import { z } from "zod";
import { ConversationPartSchema } from "../conversations/parts";
import { SessionSchema } from "./profile";
import { RequestSchema } from "./request";

export const SessionMessageSchema = z.object({
  messageId: z.string(),
  requestId: z.uuid(),
  turnId: z.uuid(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  parts: z.array(ConversationPartSchema),
  final: z.boolean(),
  occurredAt: z.iso.datetime(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export const SessionConversationSchema = z.object({
  session: SessionSchema.pick({ state: true, reasonCode: true }),
  requests: z.array(RequestSchema),
  messages: z.array(SessionMessageSchema),
  cursor: z.string(),
  reset: z.boolean(),
});
export type SessionConversation = z.infer<typeof SessionConversationSchema>;

import { digestOf } from "../common/canonical";
import { RequestInputSchema } from "./request";

// The controller chooses deadlines; replay depends only on the caller's content.
export function fingerprintRequest(input: unknown) {
  const { message, attachments } = RequestInputSchema.parse(input);
  return digestOf({ message, attachments });
}

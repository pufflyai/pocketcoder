import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

// One workspace can hold several conversations. Without --conversation this lists them;
// with it, it prints that conversation's messages, or deletes it with --delete.
export function addConversationsCommand(parser: Argv) {
  return addAction(
    parser,
    "conversations",
    "List a workspace's conversations, read one, or delete one",
    (command) =>
      idOption(command)
        .option("conversation", { type: "string", description: "Conversation ID to read or delete" })
        .option("cursor", { type: "string", description: "Continue after this page cursor" })
        .option("limit", { type: "number", description: "Messages per page" })
        .option("delete", { type: "boolean", default: false, description: "Delete the conversation" }),
    async (flags) => {
      const client = controlPlaneClient();
      const id = need(flags, "id");
      const conversation = flags.conversation;
      if (typeof conversation !== "string") {
        console.log(JSON.stringify(await client.conversations.listConversations(id), null, 2));
        return;
      }
      if (flags.delete) {
        await client.conversations.delete(id, conversation);
        console.log(`deleted conversation ${conversation}`);
        return;
      }
      const page = await client.conversations.read(id, conversation, {
        ...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}),
        ...(typeof flags.limit === "number" ? { limit: flags.limit } : {}),
      });
      console.log(JSON.stringify(page, null, 2));
    },
  );
}

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Argv } from "yargs";
import { controlPlaneClient, fail, need } from "../../command/cli-context";
import { addAction, addResource } from "../command";
import { mediaTypeOf } from "../workspaces/attachments";
import { sessionOption } from "./options";
import { addSessionReads } from "./reads";
import { addRequestCommands } from "./requests";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export function addSessionCommands(parser: Argv) {
  return addResource(parser, "sessions", "Manage logical agent sessions", (commands) =>
    [addSessionActions, addSessionReads, addFileActions, addRequestCommands].reduce(
      (configured, add) => add(configured),
      commands,
    ),
  );
}

function addSessionActions(parser: Argv) {
  let commands = addAction(
    parser,
    "create",
    "Create a session for a configured profile (replays after a lost reply)",
    (command) =>
      command
        .option("session", { type: "string", description: "Session ID (generated when omitted)" })
        .option("profile", { type: "string", demandOption: true, description: "Session profile name" })
        .option("owner", { type: "string", demandOption: true, description: "Owner ID for capacity limits" })
        .option("group", { type: "string", description: "Sharing group (defaults to owner)" }),
    async (flags) => {
      const sessionId = typeof flags.session === "string" ? flags.session : randomUUID();
      print(
        await controlPlaneClient().sessions.create({
          sessionId,
          profile: need(flags, "profile"),
          owner: need(flags, "owner"),
          ...(typeof flags.group === "string" ? { group: flags.group } : {}),
        }),
      );
    },
  );
  commands = addAction(commands, "get", "Get a session", sessionOption, async (flags) => {
    print(await controlPlaneClient().sessions.get(need(flags, "session")));
  });
  commands = addAction(
    commands,
    "resume",
    "Ask the controller to place compute for a session",
    sessionOption,
    async (flags) => {
      print(await controlPlaneClient().sessions.resume(need(flags, "session")));
    },
  );
  commands = addAction(
    commands,
    "close",
    "Close a session: reject new requests and stop its work",
    sessionOption,
    async (flags) => {
      print(await controlPlaneClient().sessions.close(need(flags, "session")));
    },
  );
  commands = addAction(
    commands,
    "history",
    "Print retained history records and the event cursor to follow after",
    (command) => sessionOption(command).option("all", { type: "boolean", description: "Read every page" }),
    async (flags) => {
      const client = controlPlaneClient();
      const sessionId = need(flags, "session");
      print(flags.all ? await client.sessions.snapshot(sessionId) : await client.sessions.history(sessionId));
    },
  );
  commands = addAction(
    commands,
    "events",
    "Stream session events as JSON lines, resuming after a cursor",
    (command) =>
      sessionOption(command)
        .option("after", { type: "string", description: "Event cursor from history or a previous event" })
        .option("count", { type: "number", description: "Stop after this many events" }),
    async (flags) => {
      const controller = new AbortController();
      let seen = 0;
      const options = { signal: controller.signal, ...(typeof flags.after === "string" ? { after: flags.after } : {}) };
      for await (const event of controlPlaneClient().sessions.events(need(flags, "session"), options)) {
        console.log(JSON.stringify(event));
        if (typeof flags.count === "number" && ++seen >= flags.count) break;
      }
      controller.abort();
    },
  );
  return addAction(
    commands,
    "preview",
    "Open a local preview of the session's current compute",
    (command) => sessionOption(command).option("name", { type: "string", demandOption: true }),
    async (flags) => {
      print(await controlPlaneClient().sessions.openPreview(need(flags, "session"), need(flags, "name")));
    },
  );
}

function addFileActions(parser: Argv) {
  let commands = addAction(
    parser,
    "upload",
    "Register and upload one immutable input file",
    (command) =>
      sessionOption(command)
        .option("file", { type: "string", demandOption: true, description: "Local file" })
        .option("input-id", { type: "string", description: "Input ID to retry (generated when omitted)" }),
    async (flags) => {
      const path = need(flags, "file");
      const inputId = typeof flags["input-id"] === "string" ? flags["input-id"] : randomUUID();
      const bytes = new Uint8Array(await readFile(path));
      print(
        await controlPlaneClient().files.put(need(flags, "session"), {
          inputId,
          name: basename(path),
          mediaType: mediaTypeOf(path),
          bytes,
        }),
      );
    },
  );
  commands = addAction(
    commands,
    "input",
    "Get an input's readiness and immutable reference",
    (command) => sessionOption(command).option("input-id", { type: "string", demandOption: true }),
    async (flags) => {
      print(await controlPlaneClient().files.get(need(flags, "session"), need(flags, "input-id")));
    },
  );
  commands = addAction(
    commands,
    "exports",
    "List one request's retained exports",
    (command) => sessionOption(command).option("request", { type: "string", demandOption: true }),
    async (flags) => {
      print(await controlPlaneClient().files.exports(need(flags, "session"), need(flags, "request")));
    },
  );
  return addAction(
    commands,
    "download",
    "Download retained export bytes",
    (command) =>
      sessionOption(command)
        .option("export", { type: "string", demandOption: true })
        .option("out", { type: "string", demandOption: true, description: "Destination file" }),
    async (flags) => {
      const out = need(flags, "out");
      const bytes = await controlPlaneClient().files.content(need(flags, "session"), need(flags, "export"));
      if (!bytes) fail("export is unavailable");
      await writeFile(out, bytes);
      print({ out, sizeBytes: bytes.byteLength });
    },
  );
}

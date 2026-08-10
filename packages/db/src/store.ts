import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { OutboxCommands } from "./commands/outbox";

// Each command layer adds one part of the Store contract to this public facade.
export class PostgresStore extends OutboxCommands implements Store {}

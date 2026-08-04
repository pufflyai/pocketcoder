import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { PostgresOutboxStore } from "./store-outbox";

export class PostgresStore extends PostgresOutboxStore implements Store {}

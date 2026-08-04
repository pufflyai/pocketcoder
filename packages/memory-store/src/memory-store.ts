import type { Store } from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryOutboxStore } from "./memory-store-outbox";

export class MemoryStore extends MemoryOutboxStore implements Store {}

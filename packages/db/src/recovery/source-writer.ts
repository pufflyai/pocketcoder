import { digestOf, type SourceWriter } from "@pstdio/pocketcoder-contracts";

export function sourceWriterIdentity(writer: SourceWriter) {
  return digestOf({ root: writer.root, lock: writer.lock });
}

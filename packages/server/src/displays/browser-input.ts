import { BrowserActionSchema } from "@pstdio/pocketcoder-contracts";

export class BrowserInput {
  constructor(private readonly control: boolean) {}

  receive(bytes: Uint8Array) {
    if (!this.control || bytes.byteLength > 4096) throw new Error("Browser input is not allowed.");
    const action = BrowserActionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return [new TextEncoder().encode(JSON.stringify(action))];
  }
}

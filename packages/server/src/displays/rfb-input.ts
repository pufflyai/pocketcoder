const VERSION = "RFB 003.008\n";

export class RfbInput {
  private pending = Buffer.alloc(0);
  private phase: "version" | "security" | "init" | "messages" = "version";

  constructor(private readonly control: boolean) {}

  receive(bytes: Uint8Array) {
    if (this.pending.length + bytes.length > 65_536) throw new Error("RFB input exceeds its limit.");
    this.pending = Buffer.concat([this.pending, bytes]);
    const messages: Uint8Array[] = [];
    while (this.pending.length) {
      const length = this.messageLength();
      if (length === null || this.pending.length < length) break;
      const message = this.pending.subarray(0, length);
      this.validate(message);
      messages.push(message);
      this.pending = this.pending.subarray(length);
    }
    return messages;
  }

  private messageLength() {
    if (this.phase === "version") return 12;
    if (this.phase === "security" || this.phase === "init") return 1;
    const type = this.pending[0];
    if (type === 0) return 20;
    if (type === 2) {
      if (this.pending.length < 4) return null;
      const count = this.pending.readUInt16BE(2);
      if (count > 256) throw new Error("Too many RFB encodings.");
      return 4 + count * 4;
    }
    if (type === 3) return 10;
    if (type === 4) return 8;
    if (type === 5) return 6;
    throw new Error("Unsupported RFB client message.");
  }

  private validate(message: Buffer) {
    if (this.phase === "version") {
      if (message.toString() !== VERSION) throw new Error("Only RFB 3.8 is supported.");
      this.phase = "security";
    } else if (this.phase === "security") {
      if (message[0] !== 1) throw new Error("Unsupported RFB security type.");
      this.phase = "init";
    } else if (this.phase === "init") {
      if (message[0] !== 1) throw new Error("RFB clients must share the desktop.");
      this.phase = "messages";
    } else if (!this.control && (message[0] === 4 || message[0] === 5)) {
      throw new Error("Desktop control permission is required.");
    }
  }
}

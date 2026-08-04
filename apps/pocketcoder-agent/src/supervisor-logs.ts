import { type AgentFrame, ConversationMessageInputSchema } from "@pstdio/pocketcoder-contracts";
import { isConversationControlLine, pumpLineFramedText, splitUtf8Chunks } from "./supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export class SupervisorLogs {
	private outputBuffer = "";

	constructor(private readonly send: SendFrame) {}

	async pump(stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr") {
		if (!stream) return;
		await pumpLineFramedText(
			stream,
			(text) => {
				if (name === "stdout" && isConversationControlLine(text)) return;
				this.emit(name, text);
			},
			name === "stdout" ? (value) => this.captureOutputs(value) : undefined,
		);
	}

	log(message: string) {
		this.send("log_chunk", {
			stream: "runtime",
			content_b64: Buffer.from(`${message}\n`).toString("base64"),
			occurred_at: new Date().toISOString(),
		});
	}

	private emit(stream: "stdout" | "stderr", text: string) {
		for (const chunk of splitUtf8Chunks(text)) {
			this.send("log_chunk", {
				stream,
				content_b64: Buffer.from(chunk).toString("base64"),
				occurred_at: new Date().toISOString(),
			});
		}
	}

	private captureOutputs(value: Uint8Array) {
		this.outputBuffer += Buffer.from(value).toString("utf8");
		const lines = this.outputBuffer.split("\n");
		this.outputBuffer = lines.pop() ?? "";
		for (const line of lines) this.captureControlLine(line);
	}

	private captureControlLine(line: string) {
		if (line.startsWith("POCKETCODER_OUTPUT ")) {
			try {
				const parsed = JSON.parse(line.slice("POCKETCODER_OUTPUT ".length)) as {
					name?: unknown;
					value?: unknown;
				};
				if (typeof parsed.name === "string") {
					this.send("output_published", { name: parsed.name, value: parsed.value });
				}
			} catch {
				this.log("ignored malformed POCKETCODER_OUTPUT line");
			}
			return;
		}
		if (!line.startsWith("POCKETCODER_CONVERSATION ")) return;
		try {
			const parsed = ConversationMessageInputSchema.safeParse(
				JSON.parse(line.slice("POCKETCODER_CONVERSATION ".length)),
			);
			if (parsed.success) this.send("conversation_message", parsed.data);
			else this.log("ignored invalid POCKETCODER_CONVERSATION line");
		} catch {
			this.log("ignored malformed POCKETCODER_CONVERSATION line");
		}
	}
}

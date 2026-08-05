import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

type AssistantEvent = Parameters<AssistantMessageEventStream["push"]>[0];

export interface AssistantEventSink {
	push(event: AssistantEvent): void;
}

function textOf(message: AssistantMessage): string {
	const content = message.content[0];
	return content?.type === "text" ? content.text : "";
}

export async function emitRemoteResponse(
	stream: AssistantEventSink,
	output: AssistantMessage,
	send: (onSnapshot: (snapshot: string) => void) => Promise<string>,
	onOutputStart: () => void = () => {},
): Promise<void> {
	let previous = "";
	let started = false;
	const update = (snapshot: string) => {
		if (snapshot === previous) return;
		const delta = snapshot.startsWith(previous) ? snapshot.slice(previous.length) : "";
		if (!started) {
			output.content.push({ type: "text", text: "" });
			started = true;
			onOutputStart();
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
		}
		const content = output.content[0];
		if (content?.type === "text") content.text = snapshot;
		previous = snapshot;
		stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
	};

	const final = await send(update);
	update(final);
	if (!started) update("");
	stream.push({ type: "text_end", contentIndex: 0, content: textOf(output), partial: output });
	output.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: output });
}

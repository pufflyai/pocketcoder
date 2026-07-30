export interface CodingSession {
	prompt(content: string): Promise<string>;
	dispose(): void | Promise<void>;
}

interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	type: "user" | "assistant";
	content: string;
	created_at: string;
	error?: string;
}

export class PiHarness {
	private readonly messages: ConversationMessage[] = [];
	private sequence = 0;
	private pending = 0;
	private tail = Promise.resolve();

	constructor(private readonly session: CodingSession) {}

	submit(content: string): string {
		const user = this.append("user", content);
		this.pending += 1;
		this.tail = this.tail.then(async () => {
			try {
				const response = await this.session.prompt(content);
				this.append("assistant", response);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				this.append("assistant", `Pi harness error: ${detail}`, detail);
			} finally {
				this.pending -= 1;
			}
		});
		return user.id;
	}

	async whenIdle(): Promise<void> {
		await this.tail;
	}

	async close(): Promise<void> {
		await this.whenIdle();
		await this.session.dispose();
	}

	fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/status") {
			return Response.json({ status: this.pending > 0 ? "running" : "stable" });
		}
		if (request.method === "GET" && url.pathname === "/messages") {
			const after = url.searchParams.get("after");
			let start = 0;
			if (after) {
				const index = this.messages.findIndex((message) => message.id === after);
				if (index >= 0) start = index + 1;
			}
			return Response.json({ messages: this.messages.slice(start) });
		}
		if (request.method === "POST" && url.pathname === "/message") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "body must be JSON" }, { status: 400 });
			}
			const content =
				typeof body === "object" && body !== null && "content" in body ? body.content : undefined;
			if (typeof content !== "string" || content.trim() === "") {
				return Response.json({ error: "content must be a non-empty string" }, { status: 400 });
			}
			return Response.json({ accepted: true, message_id: this.submit(content) });
		}
		return new Response("not found", { status: 404 });
	};

	private append(
		role: ConversationMessage["role"],
		content: string,
		error?: string,
	): ConversationMessage {
		this.sequence += 1;
		const message: ConversationMessage = {
			id: String(this.sequence),
			role,
			type: role,
			content,
			created_at: new Date().toISOString(),
			...(error ? { error } : {}),
		};
		this.messages.push(message);
		return message;
	}
}

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PocketCoderClient, PocketCoderError } from "./index";

const WORKSPACE = randomUUID();

function descriptor(id: string, name = "report.pdf") {
	return {
		id,
		name,
		path: `/home/pocketcoder/.pcd/attachments/${id}/${name}`,
		media_type: "application/pdf",
		size_bytes: 11,
		sha256: "a".repeat(64),
	};
}

function fixtureClient(
	respond: (request: Request) => Response | Promise<Response>,
	requests: Request[] = [],
) {
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		requests.push(request);
		return await respond(request);
	}) as typeof fetch;
	return new PocketCoderClient(
		{ baseUrl: "http://pocketcoder.test", apiKey: "pkt_example" },
		fetchImpl,
	);
}

describe("attachments.upload", () => {
	test("PUTs raw bytes with disposition, media type, and length headers", async () => {
		const attachmentId = randomUUID();
		const requests: Request[] = [];
		const client = fixtureClient(
			() => Response.json(descriptor(attachmentId), { status: 201 }),
			requests,
		);

		const uploaded = await client.attachments.upload(WORKSPACE, {
			id: attachmentId,
			name: "report.pdf",
			mediaType: "application/pdf",
			body: "hello bytes",
			sizeBytes: 11,
		});
		expect(uploaded.id).toBe(attachmentId);

		const request = requests[0] as Request;
		expect(request.method).toBe("PUT");
		expect(new URL(request.url).pathname).toBe(
			`/v1/workspaces/${WORKSPACE}/attachments/${attachmentId}`,
		);
		expect(request.headers.get("content-type")).toBe("application/pdf");
		expect(request.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
		expect(request.headers.get("authorization")).toBe("Bearer pkt_example");
		expect(await request.text()).toBe("hello bytes");
	});

	test("generates a UUID when the caller omits the id", async () => {
		const requests: Request[] = [];
		const client = fixtureClient((request) => {
			const id = new URL(request.url).pathname.split("/").at(-1) as string;
			return Response.json(descriptor(id), { status: 201 });
		}, requests);

		const uploaded = await client.attachments.upload(WORKSPACE, {
			name: "report.pdf",
			body: "hello bytes",
			sizeBytes: 11,
		});
		expect(uploaded.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("encodes non-ASCII filenames with RFC 5987", async () => {
		const attachmentId = randomUUID();
		const requests: Request[] = [];
		const client = fixtureClient(
			() => Response.json(descriptor(attachmentId, "résumé.pdf"), { status: 201 }),
			requests,
		);
		await client.attachments.upload(WORKSPACE, {
			id: attachmentId,
			name: "résumé.pdf",
			body: "hello bytes",
			sizeBytes: 11,
		});
		expect(requests[0]?.headers.get("content-disposition")).toBe(
			`attachment; filename*=UTF-8''${encodeURIComponent("résumé.pdf")}`,
		);
	});

	test("reports upload progress as request bytes are consumed", async () => {
		const attachmentId = randomUUID();
		const client = fixtureClient(async (request) => {
			await request.arrayBuffer();
			return Response.json(descriptor(attachmentId), { status: 201 });
		});
		const progress: Array<[number, number]> = [];
		await client.attachments.upload(WORKSPACE, {
			id: attachmentId,
			name: "report.pdf",
			body: "hello bytes",
			sizeBytes: 11,
			onProgress: (uploaded, total) => progress.push([uploaded, total]),
		});
		expect(progress.length).toBeGreaterThan(0);
		expect(progress.at(-1)).toEqual([11, 11]);
	});

	test("surfaces the stable attachment error envelope", async () => {
		const client = fixtureClient(() =>
			Response.json(
				{
					error: {
						code: "attachment.conflict",
						message: "Different bytes exist.",
						request_id: "req-1",
					},
				},
				{ status: 409 },
			),
		);
		try {
			await client.attachments.upload(WORKSPACE, {
				id: randomUUID(),
				name: "report.pdf",
				body: "hello bytes",
				sizeBytes: 11,
			});
			throw new Error("expected upload to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PocketCoderError);
			expect((error as PocketCoderError).code).toBe("attachment.conflict");
		}
	});
});

describe("agent.sendMessage", () => {
	test("POSTs the user message with attachment ids", async () => {
		const requests: Request[] = [];
		const client = fixtureClient(() => Response.json({ ok: true }), requests);
		const ids = [randomUUID(), randomUUID()];
		await client.agent.sendMessage(WORKSPACE, { content: "Summarize.", attachmentIds: ids });

		const request = requests[0] as Request;
		expect(request.method).toBe("POST");
		expect(new URL(request.url).pathname).toBe(`/v1/workspaces/${WORKSPACE}/agent/message`);
		expect(await request.json()).toEqual({
			type: "user",
			content: "Summarize.",
			attachment_ids: ids,
		});
	});

	test("omits attachment_ids for plain text turns", async () => {
		const requests: Request[] = [];
		const client = fixtureClient(() => Response.json({ ok: true }), requests);
		await client.agent.sendMessage(WORKSPACE, { content: "plain" });
		expect(await (requests[0] as Request).json()).toEqual({ type: "user", content: "plain" });
	});

	test("throws the stable envelope error on rejection", async () => {
		const client = fixtureClient(() =>
			Response.json(
				{
					error: {
						code: "attachment.not_found",
						message: "Unknown attachment.",
						request_id: "req-2",
					},
				},
				{ status: 404 },
			),
		);
		try {
			await client.agent.sendMessage(WORKSPACE, {
				content: "x",
				attachmentIds: [randomUUID()],
			});
			throw new Error("expected message to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PocketCoderError);
			expect((error as PocketCoderError).code).toBe("attachment.not_found");
		}
	});
});

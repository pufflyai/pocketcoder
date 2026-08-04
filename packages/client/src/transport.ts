import { z } from "zod";
import { PocketCoderError, responseError } from "./errors";

type FetchLike = typeof fetch;

export interface PocketCoderClientConfig {
	baseUrl: string;
	apiKey: string;
	timeoutMs?: number;
	fetch?: FetchLike;
}

export interface RequestOptions {
	signal?: AbortSignal;
}

function baseUrlOf(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("PocketCoder baseUrl must be a valid HTTP(S) URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new TypeError("PocketCoder baseUrl must be a valid HTTP(S) URL");
	}
	url.pathname = url.pathname.replace(/\/$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export class PocketCoderTransport {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;

	constructor(config: PocketCoderClientConfig, fetchImpl: FetchLike = fetch) {
		this.baseUrl = baseUrlOf(config.baseUrl);
		this.apiKey = config.apiKey;
		this.timeoutMs = config.timeoutMs ?? 60_000;
		this.fetchImpl = config.fetch ?? fetchImpl;
	}

	async raw(path: string, init: RequestInit = {}) {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		return this.fetchImpl(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
			...init,
			signal,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
		});
	}

	async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
		const response = await this.raw(path, init);
		const text = await response.text();
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			throw new PocketCoderError({
				message: `PocketCoder returned a non-JSON response (${response.status})`,
				code: "client.non_json_response",
				status: response.status,
			});
		}
		if (!response.ok) throw responseError(response, body);
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			throw new PocketCoderError({
				message: `PocketCoder returned an invalid response (${response.status})`,
				code: "client.invalid_response",
				status: response.status,
				details: { issues: z.treeifyError(parsed.error) },
			});
		}
		return parsed.data;
	}
}

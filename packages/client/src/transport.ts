import { z } from "zod";
import { PocketCoderError, responseError } from "./errors";

type FetchLike = typeof fetch;

export interface PocketCoderClientConfig {
	baseUrl: string;
	apiKey: string;
	timeoutMs?: number;
	maxRetries?: number;
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
	private readonly maxRetries: number;
	private readonly fetchImpl: FetchLike;

	constructor(config: PocketCoderClientConfig, fetchImpl: FetchLike = fetch) {
		this.baseUrl = baseUrlOf(config.baseUrl);
		this.apiKey = config.apiKey;
		this.timeoutMs = config.timeoutMs ?? 60_000;
		this.maxRetries = config.maxRetries ?? 2;
		this.fetchImpl = config.fetch ?? fetchImpl;
	}

	async raw(path: string, init: RequestInit = {}) {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		const request = {
			...init,
			signal,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
		};
		const retryable = isIdempotent(request);
		for (let attempt = 0; ; attempt += 1) {
			try {
				const response = await this.fetchImpl(
					`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
					request,
				);
				if (!retryable || attempt >= this.maxRetries || !retryableStatus(response.status)) {
					return response;
				}
				await delay(retryDelayMs(response, attempt), signal);
			} catch (error) {
				if (!retryable || attempt >= this.maxRetries || signal.aborted) throw error;
				await delay(100 * 2 ** attempt, signal);
			}
		}
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

function isIdempotent(init: RequestInit) {
	const method = (init.method ?? "GET").toUpperCase();
	if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
	return new Headers(init.headers).has("idempotency-key");
}

function retryableStatus(status: number) {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number) {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	}
	return 100 * 2 ** attempt;
}

async function delay(milliseconds: number, signal: AbortSignal) {
	if (milliseconds === 0) return;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

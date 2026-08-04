import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { type NetworkEventInput, NetworkPolicySchema } from "@pstdio/pocketcoder-contracts";
import { startProxy } from "./proxy";

const close: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(close.splice(0).map((fn) => fn()));
});

async function upstream() {
	const server = createHttpServer((request, response) => {
		response.end(`${request.method} ${request.url}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing address");
	close.push(() => new Promise((resolve) => server.close(() => resolve())));
	return address.port;
}

describe("egress proxy", () => {
	test("forwards allowed HTTP without retaining query strings", async () => {
		const port = await upstream();
		const events: NetworkEventInput[] = [];
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({
				mode: "restricted",
				allow: [{ domain: "upstream.test", ports: [port], allowPrivate: true }],
			}),
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
			record: (event) => events.push(event),
		});
		close.push(proxy.close);
		const response = await fetch(`http://upstream.test:${port}/allowed?secret=hidden`, {
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		expect(await response.text()).toBe("GET /allowed?secret=hidden");
		expect(events[0]).toMatchObject({
			decision: "allow",
			transport: "http",
			host: "upstream.test",
			port,
			method: "GET",
			path: "/allowed",
		});
	});

	test("denies unmatched and private destinations", async () => {
		const events: NetworkEventInput[] = [];
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({
				mode: "restricted",
				allow: [{ domain: "private.test", ports: [443] }],
			}),
			resolve: async () => [{ address: "10.0.0.1", family: 4 }],
			record: (event) => events.push(event),
		});
		close.push(proxy.close);
		const unmatched = await fetch("http://other.test/", {
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		expect(unmatched.status).toBe(403);

		const status = await new Promise<number>((resolve, reject) => {
			const socket = connect(proxy.port, "127.0.0.1", () => {
				socket.write("CONNECT private.test:443 HTTP/1.1\r\nHost: private.test:443\r\n\r\n");
			});
			socket.once("data", (data) => {
				resolve(Number(data.toString().split(" ")[1]));
				socket.destroy();
			});
			socket.once("error", reject);
		});
		expect(status).toBe(403);
		expect(events.map((event) => event.reason)).toEqual(["no_matching_rule", "private_address"]);
	});

	test("refuses requests when audit backpressure closes admission", async () => {
		const port = await upstream();
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({
				mode: "restricted",
				allow: [{ domain: "upstream.test", ports: [port], allowPrivate: true }],
			}),
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
			record: () => {},
			canAccept: () => false,
		});
		close.push(proxy.close);
		const response = await fetch(`http://upstream.test:${port}/`, {
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		expect(response.status).toBe(503);
	});

	test("tunnels an allowed CONNECT to the single validated address", async () => {
		const port = await upstream();
		const events: NetworkEventInput[] = [];
		let resolutions = 0;
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({
				mode: "restricted",
				allow: [{ domain: "tunnel.test", ports: [port], allowPrivate: true }],
			}),
			resolve: async () => {
				resolutions += 1;
				return [{ address: "127.0.0.1", family: 4 }];
			},
			record: (event) => events.push(event),
		});
		close.push(proxy.close);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = connect(proxy.port, "127.0.0.1", () => {
				socket.write(`CONNECT tunnel.test:${port} HTTP/1.1\r\nHost: tunnel.test:${port}\r\n\r\n`);
			});
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString();
				if (data.includes("200 Connection Established") && !data.includes("GET /tunnel")) {
					socket.write("GET /tunnel HTTP/1.1\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n");
				}
				if (data.includes("GET /tunnel")) resolve(data);
			});
			socket.on("error", reject);
		});
		expect(response).toContain("GET /tunnel");
		expect(resolutions).toBe(1);
		expect(events[0]).toMatchObject({
			decision: "allow",
			transport: "https",
			host: "tunnel.test",
			port,
			method: null,
			path: null,
		});
	});

	test("audits malformed CONNECT targets without echoing them into a URL", async () => {
		const events: NetworkEventInput[] = [];
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({ mode: "restricted", allow: [] }),
			record: (event) => events.push(event),
		});
		close.push(proxy.close);
		await new Promise<void>((resolve, reject) => {
			const socket = connect(proxy.port, "127.0.0.1", () => {
				socket.write("CONNECT example.com HTTP/1.1\r\nHost: example.com\r\n\r\n");
			});
			socket.once("data", () => {
				socket.destroy();
				resolve();
			});
			socket.once("error", reject);
		});
		expect(events[0]).toMatchObject({
			decision: "deny",
			host: "invalid",
			reason: "malformed_target",
		});
		expect(JSON.stringify(events)).not.toContain("example.com");
	});

	test("evaluates redirects as new policy decisions", async () => {
		const server = createHttpServer((_request, response) => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing address");
			response.writeHead(302, { location: `http://blocked.test:${address.port}/secret` });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing address");
		close.push(() => new Promise((resolve) => server.close(() => resolve())));
		const events: NetworkEventInput[] = [];
		const proxy = await startProxy({
			policy: NetworkPolicySchema.parse({
				mode: "restricted",
				allow: [{ domain: "redirect.test", ports: [address.port], allowPrivate: true }],
			}),
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
			record: (event) => events.push(event),
		});
		close.push(proxy.close);
		const response = await fetch(`http://redirect.test:${address.port}/`, {
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		expect(response.status).toBe(403);
		expect(events.map(({ decision, host }) => ({ decision, host }))).toEqual([
			{ decision: "allow", host: "redirect.test" },
			{ decision: "deny", host: "blocked.test" },
		]);
	});
});

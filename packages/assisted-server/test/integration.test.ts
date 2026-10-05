import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { startAssistedServer, type AssistedServer } from "../src/server.ts";
import { isPrivateAddress } from "../src/guard.ts";
import { AssistedTransport } from "../../transport-assisted/src/client.ts";

const BIG = Buffer.alloc(5 * 1024 * 1024).map(
	(_, i) => (i * 31 + (i >> 8)) & 255,
);
const sha = (b: Uint8Array | Buffer) =>
	createHash("sha256").update(b).digest("hex");

let origin: http.Server;
let originPort = 0;
let assisted: AssistedServer;
let transport: AssistedTransport;
let abortedByClient = false;

async function readAll(
	stream: ReadableStream | null | undefined | unknown,
): Promise<Buffer> {
	if (!stream) return Buffer.alloc(0);
	return Buffer.from(
		await new Response(stream as ReadableStream).arrayBuffer(),
	);
}
const url = (path: string) => new URL(`http://127.0.0.1:${originPort}${path}`);
const get = (
	path: string,
	headers: [string, string][] = [],
	signal?: AbortSignal,
) => transport.request(url(path), "GET", null, headers, signal);

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? "/";
		if (path === "/early-hints" || path === "/early-hints-redirect") {
			res.writeProcessing();
			res.writeEarlyHints({
				link: "</hint.css>; rel=preload; as=style",
				"x-interim": "discard",
			});
			if (path.endsWith("redirect"))
				return res.writeHead(302, { location: "/hello" }).end();
			res.setHeader("x-final", "kept");
			return res.end("final response");
		}
		if (path === "/hello") {
			res.setHeader("x-dup", ["1", "2"]);
			res.setHeader("content-type", "text/plain");
			return res.end("hello");
		}
		if (path === "/gzip") {
			res.setHeader("content-encoding", "gzip");
			return res.end(zlib.gzipSync("zipped body"));
		}
		if (path === "/br") {
			res.setHeader("content-encoding", "br");
			return res.end(zlib.brotliCompressSync("brotli body"));
		}
		if (path === "/big") return res.end(BIG);
		if (path === "/redirect") {
			res.writeHead(302, { location: "/hello" });
			return res.end();
		}
		if (path === "/nobody") {
			res.writeHead(204);
			return res.end();
		}
		if (path === "/echo") {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			return void req.on("end", () => res.end(Buffer.concat(chunks)));
		}
		if (path === "/hang") {
			res.writeHead(200);
			res.write("start");
			res.on("close", () => (abortedByClient = true));
			return;
		}
		if (path === "/accept-encoding")
			return res.end(String(req.headers["accept-encoding"]));
		res.writeHead(404).end("nope");
	});
	const wss = new WebSocketServer({ server: origin, path: "/ws" });
	wss.on("connection", (socket, req) => {
		socket.on("message", (data, isBinary) =>
			socket.send(data, { binary: isBinary }),
		);
		socket.send("proto:" + (req.headers["sec-websocket-protocol"] ?? ""));
	});
	await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
	originPort = (origin.address() as net.AddressInfo).port;

	assisted = await startAssistedServer({ guard: { allowPrivate: true } });
	transport = new AssistedTransport({
		url: `ws://127.0.0.1:${assisted.port}/assisted`,
	});
	await transport.init();
});

after(async () => {
	transport.close();
	await assisted.close();
	origin.close();
});

describe("requests", () => {
	for (const status of [200, 302]) {
		test(`ignores informational headers before the final ${status} response`, async () => {
			const r = await get(
				status === 200 ? "/early-hints" : "/early-hints-redirect",
			);
			assert.equal(r.status, status);
			assert.equal(
				r.headers.some(([k]) => k === "x-interim" || k === "link"),
				false,
			);
			if (status === 200) {
				assert.equal(r.headers.find(([k]) => k === "x-final")?.[1], "kept");
				assert.equal((await readAll(r.body)).toString(), "final response");
			} else {
				assert.equal(r.headers.find(([k]) => k === "location")?.[1], "/hello");
				assert.equal((await readAll(r.body)).length, 0);
			}
		});
	}
	test("returns status, headers (repeated values preserved) and body", async () => {
		const r = await get("/hello");
		assert.equal(r.status, 200);
		assert.equal((await readAll(r.body)).toString(), "hello");

		const dups = r.headers
			.filter(([k]) => k.toLowerCase() === "x-dup")
			.flatMap(([, v]) => v.split(/\s*,\s*/));
		assert.deepEqual(dups, ["1", "2"]);
	});

	test("does not follow redirects", async () => {
		const r = await get("/redirect");
		assert.equal(r.status, 302);
		assert.equal(
			r.headers.find(([k]) => k.toLowerCase() === "location")?.[1],
			"/hello",
		);
	});

	test("decodes gzip and brotli in the client and drops the encoding headers", async () => {
		for (const [path, text] of [
			["/gzip", "zipped body"],
			["/br", "brotli body"],
		] as const) {
			const r = await get(path);
			assert.equal((await readAll(r.body)).toString(), text);
			assert.equal(
				r.headers.some(([k]) =>
					["content-encoding", "content-length"].includes(k.toLowerCase()),
				),
				false,
			);
		}
	});

	test("advertises only encodings the client can decode", async () => {
		const r = await get("/accept-encoding", [
			["Accept-Encoding", "gzip, deflate, br, zstd"],
		]);
		const sent = (await readAll(r.body)).toString();
		assert.ok(!sent.includes("zstd"), sent);
		assert.ok(sent.includes("gzip"));
	});

	test("204 and HEAD yield no body", async () => {
		assert.equal((await get("/nobody")).body, null);
		const head = await transport.request(
			url("/hello"),
			"HEAD",
			null,
			[],
			undefined,
		);
		assert.equal(head.body, null);
		assert.equal(head.status, 200);
	});

	test("streams a 5 MB body intact and with backpressure from a slow reader", async () => {
		const r = await get("/big");
		const reader = (r.body as ReadableStream<Uint8Array>).getReader();
		const hash = createHash("sha256");
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			total += value.byteLength;
			if (total % (1024 * 1024) < 70_000)
				await new Promise((res) => setTimeout(res, 20));
		}
		assert.equal(total, BIG.length);
		assert.equal(hash.digest("hex"), sha(BIG));
	});

	test("sends request bodies (string, bytes and a stream)", async () => {
		const post = async (body: BodyInit) =>
			readAll(
				(await transport.request(url("/echo"), "POST", body, [], undefined))
					.body,
			);
		assert.equal((await post("text body")).toString(), "text body");
		assert.deepEqual([...(await post(new Uint8Array([1, 2, 3])))], [1, 2, 3]);
		const big = Buffer.alloc(600_000, 7);
		const streamed = new ReadableStream({
			start(c) {
				c.enqueue(big.subarray(0, 300_000));
				c.enqueue(big.subarray(300_000));
				c.close();
			},
		});
		assert.equal(sha(await post(streamed)), sha(big));
	});

	test("abort rejects before the response and closes the upstream request", async () => {
		const ctl = new AbortController();
		const p = get("/hang", [], ctl.signal).then((r) => r);
		const r = await p;
		const reader = (r.body as ReadableStream).getReader();
		await reader.read();
		await reader.cancel();
		await new Promise((res) => setTimeout(res, 200));
		assert.equal(abortedByClient, true);

		const early = new AbortController();
		early.abort();
		await assert.rejects(get("/hello", [], early.signal), {
			name: "AbortError",
		});
	});

	test("many concurrent requests share one connection", async () => {
		const results = await Promise.all(
			Array.from({ length: 40 }, () =>
				get("/hello").then((r) => readAll(r.body)),
			),
		);
		assert.ok(results.every((b) => b.toString() === "hello"));
	});

	test("an unreachable origin becomes a rejected request, not a hang", async () => {
		const dead = net.createServer().listen(0, "127.0.0.1");
		await new Promise((r) => dead.once("listening", r));
		const port = (dead.address() as net.AddressInfo).port;
		await new Promise((r) => dead.close(r));
		await assert.rejects(
			transport.request(
				new URL(`http://127.0.0.1:${port}/`),
				"GET",
				null,
				[],
				undefined,
			),
		);
	});
});

describe("websocket tunnel", () => {
	test("relays text and binary and negotiates a subprotocol", async () => {
		const received: (string | ArrayBuffer)[] = [];
		let opened = "";
		const done = new Promise<void>((resolve) => {
			const [send] = transport.connect(
				new URL(`ws://127.0.0.1:${originPort}/ws`),
				["chat"],
				[],
				(protocol) => {
					opened = protocol;
					send("ping");
					send(new Uint8Array([9, 8, 7]).buffer);
				},
				(data) => {
					received.push(data as string | ArrayBuffer);
					if (received.length === 3) resolve();
				},
				() => {},
				() => {},
			);
		});
		await done;
		assert.equal(opened, "chat");
		assert.equal(received[0], "proto:chat");
		assert.equal(received[1], "ping");
		assert.deepEqual(
			[...new Uint8Array(received[2] as ArrayBuffer)],
			[9, 8, 7],
		);
	});

	test("reports a failed upgrade as error + close", async () => {
		const events: string[] = [];
		await new Promise<void>((resolve) => {
			transport.connect(
				new URL(`ws://127.0.0.1:${originPort}/not-a-websocket`),
				[],
				[],
				() => events.push("open"),
				() => {},
				() => {
					events.push("close");
					resolve();
				},
				() => events.push("error"),
			);
		});
		assert.ok(
			events.includes("error") &&
				events.includes("close") &&
				!events.includes("open"),
			events.join(),
		);
	});
});

describe("guard and auth", () => {
	test("private addresses are refused unless allowed", async () => {
		const strict = await startAssistedServer({});
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${strict.port}/assisted`,
		});
		try {
			await assert.rejects(
				t.request(url("/hello"), "GET", null, [], undefined),
				/blocked|EBLOCKED/i,
			);
		} finally {
			t.close();
			await strict.close();
		}
	});

	test("isPrivateAddress classifies ranges", () => {
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"::1",
			"fd00::1",
			"fe80::1",
			"fec0::1",
			"feff::1",
			"64:ff9b:1::a00:1",
			"::ffff:10.0.0.1",
		]) {
			assert.equal(isPrivateAddress(ip), true, ip);
		}
		for (const ip of [
			"8.8.8.8",
			"1.1.1.1",
			"172.32.0.1",
			"2606:4700:4700::1111",
			"93.184.216.34",
		]) {
			assert.equal(isPrivateAddress(ip), false, ip);
		}
	});

	test("isPrivateAddress sees through IPv6 forms that embed IPv4", () => {
		for (const raw of [
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"[::ffff:127.0.0.1]",
		]) {
			const host = new URL(
				`http://${raw.startsWith("[") ? raw : "[" + raw + "]"}/`,
			).hostname.replace(/^\[|\]$/g, "");
			assert.equal(isPrivateAddress(host), true, `${raw} -> ${host}`);
		}
		for (const ip of [
			"::ffff:a00:1",
			"::127.0.0.1",
			"::7f00:1",
			"64:ff9b::7f00:1",
			"64:ff9b::a9fe:a9fe",
			"2002:7f00:1::",
			"2002:a9fe:a9fe::1",
			"2001:0:4136:e378:8000:63bf:3fff:fdd2",
			"fc00::1",
			"ff02::1",
			"0:0:0:0:0:0:0:1",
		]) {
			assert.equal(isPrivateAddress(ip), true, ip);
		}
		for (const ip of [
			"::ffff:808:808",
			"64:ff9b::808:808",
			"2002:808:808::1",
			"2606:4700::1111",
			"2001:4860:4860::8888",
		]) {
			assert.equal(isPrivateAddress(ip), false, ip);
		}
	});

	test("a token is required when configured", async () => {
		const locked = await startAssistedServer({
			token: "s3cret",
			guard: { allowPrivate: true },
		});
		try {
			const bad = new AssistedTransport({
				url: `ws://127.0.0.1:${locked.port}/assisted`,
				token: "wrong",
			});
			await assert.rejects(bad.init());
			bad.close();
			const good = new AssistedTransport({
				url: `ws://127.0.0.1:${locked.port}/assisted`,
				token: "s3cret",
			});
			await good.init();
			assert.equal(
				(
					await readAll(
						(await good.request(url("/hello"), "GET", null, [], undefined))
							.body,
					)
				).toString(),
				"hello",
			);
			good.close();
		} finally {
			await locked.close();
		}
	});

	test("reconnects after the connection drops", async () => {
		const s = await startAssistedServer({ guard: { allowPrivate: true } });
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${s.port}/assisted`,
		});
		try {
			await t.init();
			(t as unknown as { socket: WebSocket }).socket.close();
			await new Promise((r) => setTimeout(r, 100));
			assert.equal(
				(
					await readAll(
						(await t.request(url("/hello"), "GET", null, [], undefined)).body,
					)
				).toString(),
				"hello",
			);
		} finally {
			t.close();
			await s.close();
		}
	});
});

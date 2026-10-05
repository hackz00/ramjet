import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startAssistedServer, type AssistedServer } from "../src/server.ts";
import { AssistedTransport } from "../../transport-assisted/src/client.ts";
import {
	T,
	encodeFrame,
	encodeJson,
	decodeFrame,
	decodeWsData,
} from "../../transport-assisted/src/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeoutMs = <T>(p: Promise<T>, ms: number) =>
	Promise.race([p, sleep(ms).then(() => "timeout" as const)]);
const readAll = async (stream: unknown) =>
	Buffer.from(await new Response(stream as ReadableStream).arrayBuffer());

let origin: http.Server;
let originPort = 0;
const state = {
	streamStarted: 0,
	streamClosed: 0,
	streamBytes: 0,
	uploadBytesAtProbe: 0,
	downloadBytesWritten: 0,
};
let releaseUpload: () => void = () => {};

before(async () => {
	origin = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/length-mismatch") {
			req.on("data", () => {});
			return void req.on("end", () => res.end("complete"));
		}
		if (url === "/endless") {
			state.streamStarted++;
			res.writeHead(200);
			res.on("close", () => state.streamClosed++);
			const pump = () => {
				while (!res.destroyed) {
					const chunk = Buffer.alloc(64 * 1024, 1);
					state.streamBytes += chunk.length;
					if (!res.write(chunk)) return void res.once("drain", pump);
				}
			};
			return pump();
		}
		if (url === "/empty-gzip") {
			res.writeHead(200, { "content-encoding": "gzip" });
			return res.end();
		}
		if (url === "/slow-upload") {
			const chunks: Buffer[] = [];
			new Promise<void>((r) => (releaseUpload = r)).then(() => {
				req.on("data", (c) => chunks.push(c));
				req.on("end", () => res.end(String(Buffer.concat(chunks).length)));
			});
			return;
		}
		if (url === "/big20") {
			state.downloadBytesWritten = 0;
			res.writeHead(200);
			const total = 20 * 1024 * 1024;
			let sent = 0;
			const pump = () => {
				while (sent < total) {
					const chunk = Buffer.alloc(64 * 1024, 2);
					sent += chunk.length;
					state.downloadBytesWritten = sent;
					if (!res.write(chunk)) return void res.once("drain", pump);
				}
				res.end();
			};
			return pump();
		}
		res.end("ok");
	});
	await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
	originPort = (origin.address() as net.AddressInfo).port;
});

after(() => origin.close());

async function rawClient(server: AssistedServer): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/assisted`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return ws;
}

describe("malformed input never takes the server down", () => {
	test("invalid declared lengths and short/long uploads fail only their stream", async () => {
		const server = await startAssistedServer({
			guard: { allowPrivate: true },
			maxRequestBodyBytes: 1024,
		});
		const ws = await rawClient(server);
		try {
			ws.send(encodeJson(T.HELLO, 0, {}));
			let id = 10;
			for (const [length, hasBody, bytes] of [
				[-1, true, undefined],
				["4", true, undefined],
				[1.5, true, undefined],
				[1025, true, undefined],
				[4, false, undefined],
				[0, true, undefined],
				[4, true, 2],
				[4, true, 5],
			] as const) {
				const streamId = id++;
				const received = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						ws.off("message", listener);
						reject(new Error("missing length error"));
					}, 2000);
					function listener(data: WebSocket.RawData) {
						const frame = decodeFrame(new Uint8Array(data as Buffer));
						if (frame?.id !== streamId || frame.type !== T.ERROR) return;
						clearTimeout(timer);
						ws.off("message", listener);
						resolve();
					}
					ws.on("message", listener);
				});
				ws.send(
					encodeJson(T.REQUEST, streamId, {
						method: "POST",
						url: `http://127.0.0.1:${originPort}/length-mismatch`,
						headers: [],
						hasBody,
						bodyLength: length,
					}),
				);
				if (bytes !== undefined) {
					ws.send(encodeFrame(T.REQ_BODY, streamId, new Uint8Array(bytes)));
					ws.send(encodeFrame(T.REQ_END, streamId));
				}
				await received;
			}
			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
			});
			try {
				await t.init();
				const r = await t.request(
					new URL(`http://127.0.0.1:${originPort}/`),
					"GET",
					null,
					[],
					undefined,
				);
				assert.equal((await readAll(r.body)).toString(), "ok");
			} finally {
				t.close();
			}
		} finally {
			ws.terminate();
			await server.close();
		}
	});
	test("garbage frames, bad JSON, wrong types and invalid close codes only close that connection", async () => {
		const server = await startAssistedServer({
			token: "secret",
			guard: { allowPrivate: true },
		});
		const survived = new Promise<never>((_, reject) =>
			process.once("uncaughtException", reject),
		);
		try {
			const bad: Uint8Array[] = [
				encodeFrame(T.HELLO, 0, new TextEncoder().encode("not json")),
				encodeJson(T.HELLO, 0, { token: 12345 }),
				encodeJson(T.HELLO, 0, null),
				new Uint8Array([1, 2]),
			];
			for (const frame of bad) {
				const ws = await rawClient(server);
				const closed = new Promise((r) => ws.once("close", r));
				ws.send(frame);
				await Promise.race([closed, sleep(1000)]);
				ws.terminate();
			}

			const ws = await rawClient(server);
			ws.send(encodeJson(T.HELLO, 0, { token: "secret" }));
			await sleep(50);
			for (const frame of [
				encodeJson(T.REQUEST, 1, {
					method: "GET",
					url: `http://127.0.0.1:${originPort}/`,
					headers: 5,
					hasBody: false,
				}),
				encodeJson(T.WS_OPEN, 2, {
					url: `ws://127.0.0.1:${originPort}/`,
					protocols: ["a", "a"],
					headers: [],
				}),
				encodeFrame(T.REQUEST, 3, new TextEncoder().encode("{")),
				encodeJson(T.WS_CLOSE, 4, { code: 1000, reason: "x".repeat(500) }),
			]) {
				ws.send(frame);
			}
			await sleep(200);
			ws.terminate();

			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
				token: "secret",
			});
			await t.init();
			const r = await t.request(
				new URL(`http://127.0.0.1:${originPort}/`),
				"GET",
				null,
				[],
				undefined,
			);
			assert.equal((await readAll(r.body)).toString(), "ok");
			t.close();
		} finally {
			await Promise.race([server.close(), sleep(100)]);
			void survived.catch(() => {});
		}
	});

	test("an unauthenticated connection is dropped after a deadline", async () => {
		const server = await startAssistedServer({
			token: "secret",
			authTimeoutMs: 150,
			guard: { allowPrivate: true },
		});
		try {
			const ws = await rawClient(server);
			const code = await new Promise<number>((r) =>
				ws.once("close", (c) => r(c)),
			);
			assert.equal(code, 4401);
		} finally {
			await server.close();
		}
	});
});

describe("cancel and stream limits", () => {
	test("a CANCEL sent immediately after REQUEST still stops the upstream", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		try {
			state.streamStarted = 0;
			state.streamClosed = 0;
			state.streamBytes = 0;
			const ws = await rawClient(server);
			for (let id = 1; id <= 5; id++) {
				ws.send(
					encodeJson(T.REQUEST, id, {
						method: "GET",
						url: `http://127.0.0.1:${originPort}/endless`,
						headers: [],
						hasBody: false,
					}),
				);
				ws.send(encodeFrame(T.CANCEL, id));
			}
			await sleep(800);

			assert.equal(
				state.streamClosed,
				state.streamStarted,
				"an upstream connection was left open",
			);
			assert.ok(
				state.streamBytes < 2 * 1024 * 1024,
				`upstream kept writing: ${state.streamBytes}`,
			);
			ws.terminate();
		} finally {
			await server.close();
		}
	});

	test("a CANCEL after the response started closes the upstream connection", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		try {
			state.streamStarted = 0;
			state.streamClosed = 0;
			const ws = await rawClient(server);
			const responded = new Promise<void>((resolve) =>
				ws.on("message", (data) => {
					if (decodeFrame(new Uint8Array(data as Buffer))?.type === T.RESPONSE)
						resolve();
				}),
			);
			ws.send(
				encodeJson(T.REQUEST, 1, {
					method: "GET",
					url: `http://127.0.0.1:${originPort}/endless`,
					headers: [],
					hasBody: false,
				}),
			);
			await responded;
			ws.send(encodeFrame(T.CANCEL, 1));
			await sleep(400);
			assert.equal(state.streamStarted, 1);
			assert.equal(
				state.streamClosed,
				1,
				"upstream connection stayed open after CANCEL",
			);
			ws.terminate();
		} finally {
			await server.close();
		}
	});

	test("requests beyond the stream cap get an ERROR without disturbing existing streams", async () => {
		const server = await startAssistedServer({
			maxStreamsPerConnection: 2,
			guard: { allowPrivate: true },
		});
		try {
			const ws = await rawClient(server);
			const seen: Record<number, number[]> = {};
			ws.on("message", (data) => {
				const f = decodeFrame(new Uint8Array(data as Buffer))!;
				(seen[f.id] ??= []).push(f.type);
			});
			const req = (id: number) =>
				ws.send(
					encodeJson(T.REQUEST, id, {
						method: "GET",
						url: `http://127.0.0.1:${originPort}/endless`,
						headers: [],
						hasBody: false,
					}),
				);
			req(1);
			req(2);
			req(3);
			await sleep(300);
			assert.ok(
				seen[3]?.includes(T.ERROR),
				"stream over the cap was silently dropped",
			);
			assert.ok(
				seen[1]?.includes(T.RESP_BODY),
				"existing stream was disturbed",
			);
			ws.terminate();
		} finally {
			await server.close();
		}
	});

	test("400 concurrent requests through the client all complete (it queues instead of overrunning the server)", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${server.port}/assisted`,
		});
		try {
			await t.init();
			const results = await Promise.all(
				Array.from({ length: 400 }, () =>
					t
						.request(
							new URL(`http://127.0.0.1:${originPort}/`),
							"GET",
							null,
							[],
							undefined,
						)
						.then((r) => readAll(r.body)),
				),
			);
			assert.equal(results.length, 400);
			assert.ok(results.every((b) => b.toString() === "ok"));
		} finally {
			t.close();
			await server.close();
		}
	});
});

describe("flow control under slow peers", () => {
	test("a slow upstream does not make the server buffer the whole upload", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${server.port}/assisted`,
		});
		try {
			await t.init();
			const total = 24 * 1024 * 1024;
			const body = new Uint8Array(total).fill(7);
			const pending = t.request(
				new URL(`http://127.0.0.1:${originPort}/slow-upload`),
				"POST",
				body,
				[],
				undefined,
			);
			await sleep(600);
			const sentWhileBlocked = t.stats.uploadBytesSent;
			assert.ok(
				sentWhileBlocked < 8 * 1024 * 1024,
				`client pushed ${sentWhileBlocked} bytes into a stalled upstream`,
			);
			releaseUpload();
			const r = await pending;
			assert.equal((await readAll(r.body)).toString(), String(total));
		} finally {
			t.close();
			await server.close();
		}
	});

	test("a client that is not reading stalls the upstream instead of ballooning memory", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${server.port}/assisted`,
		});
		try {
			await t.init();
			const r = await t.request(
				new URL(`http://127.0.0.1:${originPort}/big20`),
				"GET",
				null,
				[],
				undefined,
			);
			await sleep(700);
			assert.ok(
				state.downloadBytesWritten < 6 * 1024 * 1024,
				`upstream wrote ${state.downloadBytesWritten} bytes to an idle client`,
			);
			assert.equal((await readAll(r.body)).length, 20 * 1024 * 1024);
		} finally {
			t.close();
			await server.close();
		}
	});
});

describe("preconnect hands a ready socket to the first request", () => {
	async function run(
		label: string,
		makeOrigin: (
			cert: { key: string; cert: string } | null,
		) => net.Server | null,
		scheme: string,
		expectConnections: number,
	) {
		const cert = makeCert();
		const origin = makeOrigin(cert);
		if (!origin) return;
		let connections = 0;
		origin.on("connection", () => connections++);
		await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
		const port = (origin.address() as net.AddressInfo).port;
		const server = await startAssistedServer({
			guard: { allowPrivate: true },
			insecureTls: true,
		});
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${server.port}/assisted`,
		});
		try {
			await t.init();
			t.preconnect(`${scheme}://localhost:${port}`);
			await sleep(400);
			const r = await withTimeoutMs(
				t.request(
					new URL(`${scheme}://localhost:${port}/`),
					"GET",
					null,
					[],
					undefined,
				),
				5000,
			);
			assert.notEqual(
				r,
				"timeout",
				`${label}: the request on the pre-opened socket never completed`,
			);
			assert.equal(
				(await readAll((r as { body: unknown }).body))
					.toString()
					.startsWith("ok"),
				true,
				label,
			);
			assert.equal(connections, expectConnections, `${label}: connections`);
		} finally {
			t.close();
			await server.close();
			origin.close();
			if (cert) rmSync(cert.dir, { recursive: true, force: true });
		}
	}
	const respond = (_: unknown, res: { end: (s: string) => void }) =>
		res.end("ok");

	test("plain HTTP/1.1", async () => {
		await run("http/1.1", () => http.createServer(respond as never), "http", 1);
	});
	test("TLS + HTTP/1.1", async () => {
		await run(
			"https/1.1",
			(cert) =>
				cert
					? https.createServer(
							{ key: cert.key, cert: cert.cert },
							respond as never,
						)
					: null,
			"https",
			1,
		);
	});
});

describe("response decoding", () => {
	test("an empty body that claims Content-Encoding: gzip is an empty body, not an error", async () => {
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		const t = new AssistedTransport({
			url: `ws://127.0.0.1:${server.port}/assisted`,
		});
		try {
			await t.init();
			const r = await t.request(
				new URL(`http://127.0.0.1:${originPort}/empty-gzip`),
				"GET",
				null,
				[],
				undefined,
			);
			assert.equal((await readAll(r.body)).length, 0);
			assert.equal(r.status, 200);
		} finally {
			t.close();
			await server.close();
		}
	});
});

describe("websocket tunnel under load", () => {
	test("a 128 MB stream through the tunnel arrives complete", async () => {
		const { WebSocketServer } = await import("ws");
		const originServer = http.createServer();
		const wss = new WebSocketServer({ server: originServer });
		const TOTAL = 2000;
		const CHUNK = 64 * 1024;
		wss.on("connection", (upstream) => {
			const chunk = Buffer.alloc(CHUNK, 3);
			for (let i = 0; i < TOTAL; i++) upstream.send(chunk);
			upstream.send("done");
		});
		await new Promise<void>((r) => originServer.listen(0, "127.0.0.1", r));
		const port = (originServer.address() as net.AddressInfo).port;
		const server = await startAssistedServer({ guard: { allowPrivate: true } });
		try {
			const ws = await rawClient(server);
			let bytes = 0;
			const finished = new Promise<void>((resolve) =>
				ws.on("message", (data) => {
					const frame = decodeFrame(new Uint8Array(data as Buffer))!;
					if (frame.type !== T.WS_DATA) return;
					const { isText, data: body } = decodeWsData(frame.payload);
					if (isText) return resolve();
					bytes += body.length;
				}),
			);
			ws.send(
				encodeJson(T.WS_OPEN, 1, {
					url: `ws://127.0.0.1:${port}/`,
					protocols: [],
					headers: [],
				}),
			);
			assert.notEqual(
				await withTimeoutMs(finished, 20_000),
				"timeout",
				"stream stalled",
			);
			assert.equal(bytes, TOTAL * CHUNK);
			ws.terminate();
		} finally {
			await server.close();
			for (const client of wss.clients) client.terminate();
			wss.close();
			originServer.close();
		}
	});
});

function makeCert(): { key: string; cert: string; dir: string } | null {
	const dir = mkdtempSync(path.join(tmpdir(), "ramjet-cert-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				path.join(dir, "k.pem"),
				"-out",
				path.join(dir, "c.pem"),
				"-days",
				"2",
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);
		return {
			key: readFileSync(path.join(dir, "k.pem"), "utf8"),
			cert: readFileSync(path.join(dir, "c.pem"), "utf8"),
			dir,
		};
	} catch {
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
}

describe("http2 upstream", () => {
	const cert = makeCert();
	const skip = cert ? false : "openssl not available";
	let h2: http2.Http2SecureServer;
	let h2Port = 0;
	const seen = { connections: 0, handshakes: 0, streams: 0, maxConcurrent: 0 };
	let active = 0;

	before(async () => {
		if (!cert) return;
		h2 = http2.createSecureServer({
			key: cert.key,
			cert: cert.cert,
			allowHTTP1: true,
		});
		h2.on("connection", () => seen.connections++);
		h2.on("secureConnection", () => seen.handshakes++);
		h2.on("request", async (req, res) => {
			if (req.url === "/require-length") {
				if (req.headers["content-length"] === undefined)
					return res.writeHead(411).end("length required");
				let bytes = 0;
				req.on("data", (c) => {
					bytes += c.length;
				});
				return void req.on("end", () =>
					res.end(
						JSON.stringify({
							bytes,
							length: req.headers["content-length"],
							version: req.httpVersion,
						}),
					),
				);
			}
			if (req.url === "/early-hints") {
				res.writeEarlyHints({
					link: "</hint.css>; rel=preload; as=style",
					"x-interim": "discard",
				});
				res.setHeader("x-final", "kept");
				return res.end("h2 final:" + req.httpVersion);
			}
			seen.streams++;
			active++;
			seen.maxConcurrent = Math.max(seen.maxConcurrent, active);
			await sleep(60);
			active--;
			res.end("h2:" + req.httpVersion);
		});
		await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
		h2Port = (h2.address() as net.AddressInfo).port;
	});

	after(() => {
		h2?.close();
		if (cert) rmSync(cert.dir, { recursive: true, force: true });
	});

	test(
		"HTTP/2 Early Hints do not replace final headers or consume the body",
		{ skip },
		async () => {
			const server = await startAssistedServer({
				guard: { allowPrivate: true },
				insecureTls: true,
			});
			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
			});
			try {
				await t.init();
				const r = await t.request(
					new URL(`https://localhost:${h2Port}/early-hints`),
					"GET",
					null,
					[],
					undefined,
				);
				assert.equal(r.status, 200);
				assert.equal(
					r.headers.some(([k]) => k === "x-interim" || k === "link"),
					false,
				);
				assert.equal(r.headers.find(([k]) => k === "x-final")?.[1], "kept");
				assert.equal((await readAll(r.body)).toString(), "h2 final:2.0");
			} finally {
				t.close();
				await server.close();
			}
		},
	);

	test(
		"small streamed HTTP/2 POSTs carry their actual Content-Length",
		{ skip },
		async () => {
			const server = await startAssistedServer({
				guard: { allowPrivate: true },
				insecureTls: true,
			});
			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
			});
			try {
				await t.init();
				for (const body of [
					"héllo",
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("héllo"));
							c.close();
						},
					}),
				]) {
					const r = await t.request(
						new URL(`https://localhost:${h2Port}/require-length`),
						"POST",
						body,
						[],
						undefined,
					);
					assert.equal(r.status, 200);
					assert.deepEqual(JSON.parse((await readAll(r.body)).toString()), {
						bytes: 6,
						length: "6",
						version: "2.0",
					});
				}
			} finally {
				t.close();
				await server.close();
			}
		},
	);

	test(
		"100 concurrent requests multiplex over a handful of connections",
		{ skip },
		async () => {
			const server = await startAssistedServer({
				guard: { allowPrivate: true },
				insecureTls: true,
			});
			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
			});
			try {
				await t.init();
				Object.assign(seen, {
					connections: 0,
					handshakes: 0,
					streams: 0,
					maxConcurrent: 0,
				});
				const bodies = await Promise.all(
					Array.from({ length: 100 }, () =>
						t
							.request(
								new URL(`https://localhost:${h2Port}/`),
								"GET",
								null,
								[],
								undefined,
							)
							.then((r) => readAll(r.body)),
					),
				);
				assert.ok(
					bodies.every((b) => b.toString() === "h2:2.0"),
					"requests did not negotiate HTTP/2",
				);
				assert.ok(
					seen.maxConcurrent > 20,
					`no multiplexing: max ${seen.maxConcurrent} concurrent streams`,
				);
				assert.ok(
					seen.connections <= 4,
					`${seen.connections} TCP connections for 100 requests`,
				);

				const before = seen.connections;
				await Promise.all(
					Array.from({ length: 50 }, () =>
						t
							.request(
								new URL(`https://localhost:${h2Port}/`),
								"GET",
								null,
								[],
								undefined,
							)
							.then((r) => readAll(r.body)),
					),
				);
				assert.equal(
					seen.connections,
					before,
					"second burst opened new connections",
				);
			} finally {
				t.close();
				await server.close();
			}
		},
	);

	test(
		"preconnect opens the TLS connection before the first request, which then reuses it",
		{ skip },
		async () => {
			const server = await startAssistedServer({
				guard: { allowPrivate: true },
				insecureTls: true,
			});
			const t = new AssistedTransport({
				url: `ws://127.0.0.1:${server.port}/assisted`,
			});
			try {
				await t.init();
				Object.assign(seen, {
					connections: 0,
					handshakes: 0,
					streams: 0,
					maxConcurrent: 0,
				});
				t.preconnect(`https://localhost:${h2Port}`);
				await sleep(400);
				assert.equal(
					seen.handshakes,
					1,
					"preconnect did not complete a TLS handshake",
				);
				assert.equal(seen.streams, 0, "preconnect must not send a request");
				const r = await t.request(
					new URL(`https://localhost:${h2Port}/`),
					"GET",
					null,
					[],
					undefined,
				);
				assert.equal((await readAll(r.body)).toString(), "h2:2.0");
				assert.equal(
					seen.connections,
					1,
					"the request opened a second connection",
				);
			} finally {
				t.close();
				await server.close();
			}
		},
	);
});

import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { PassThrough } from "node:stream";
import { Agent, buildConnector, type Dispatcher } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import {
	INITIAL_CREDIT,
	MAX_CHUNK,
	T,
	UPLOAD_CREDIT,
	decodeFrame,
	decodeWsData,
	encodeCredit,
	encodeFrame,
	encodeJson,
	encodeWsData,
	parseCredit,
	parseJson,
	type CloseInfo,
	type RawHeaders,
	type RequestInfo,
	type WsOpenInfo,
} from "../../transport-assisted/src/protocol.ts";
import {
	DEFAULT_GUARD,
	createGuardedLookup,
	isPrivateAddress,
	type GuardOptions,
} from "./guard.ts";

export type ServerOptions = {
	port?: number;
	host?: string;

	server?: http.Server;

	path?: string;

	token?: string;
	guard?: Partial<GuardOptions>;

	insecureTls?: boolean;
	maxStreamsPerConnection?: number;

	authTimeoutMs?: number;

	maxRequestBodyBytes?: number;
};

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
]);

type Stream = {
	abort?: () => void;
	resume?: () => void;
	pause?: () => void;
	window: number;
	body?: PassThrough;
	done: boolean;
	ws?: WebSocket;

	uploadOutstanding: number;

	uploadUncredited: number;
	uploaded: number;
	uploadLength?: number;
};

export type AssistedServer = {
	port: number;
	close: () => Promise<void>;

	resetUpstream: () => Promise<void>;
};

type ConnectOptions = {
	protocol: string;
	hostname: string;
	host?: string;
	port: string | number;
};
type ConnectCallback = (err: Error | null, socket: net.Socket | null) => void;
type Connector = (options: ConnectOptions, callback: ConnectCallback) => void;

const WARM_TTL_MS = 15_000;
const MAX_WARM = 32;
const MAX_CLOSE_REASON_BYTES = 120;

const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isHeaders = (h: unknown): h is RawHeaders =>
	Array.isArray(h) &&
	h.every(
		(p) =>
			Array.isArray(p) &&
			p.length === 2 &&
			typeof p[0] === "string" &&
			typeof p[1] === "string",
	);

const closeCode = (code: unknown): number => {
	if (typeof code !== "number" || !Number.isInteger(code)) return 1000;
	if (
		code === 1000 ||
		(code >= 1001 && code <= 1003) ||
		(code >= 1007 && code <= 1014) ||
		(code >= 3000 && code <= 4999)
	)
		return code;
	return 1000;
};
const closeReason = (reason: unknown): string => {
	let out = typeof reason === "string" ? reason : "";
	while (Buffer.byteLength(out) > MAX_CLOSE_REASON_BYTES)
		out = out.slice(0, -1);
	return out;
};

export async function startAssistedServer(
	options: ServerOptions = {},
): Promise<AssistedServer> {
	const guard = createGuardedLookup({ ...DEFAULT_GUARD, ...options.guard });
	const baseConnect = buildConnector({
		allowH2: true,
		lookup: guard.lookup as never,
		timeout: 10_000,
		rejectUnauthorized: !options.insecureTls,
	}) as unknown as Connector;

	const warm = new Map<string, { socket: net.Socket; timer: NodeJS.Timeout }>();
	const warming = new Set<string>();
	const warmKey = (protocol: string, hostname: string, port: string | number) =>
		`${protocol}//${hostname}:${port}`;
	const dropWarm = (key: string) => {
		const hit = warm.get(key);
		if (!hit) return;
		warm.delete(key);
		clearTimeout(hit.timer);
	};
	const connect: Connector = (opts, callback) => {
		const key = warmKey(opts.protocol, opts.hostname, opts.port);
		const hit = warm.get(key);
		if (hit) {
			dropWarm(key);

			if (!hit.socket.destroyed)
				return void process.nextTick(callback, null, hit.socket);
		}
		baseConnect(opts, callback);
	};
	const makeAgent = () =>
		new Agent({
			allowH2: true,
			connections: 32,
			pipelining: 1,
			keepAliveTimeout: 30_000,
			keepAliveMaxTimeout: 120_000,
			connect: connect as unknown as buildConnector.connector,
		});
	let agent = makeAgent();

	const maxStreams = options.maxStreamsPerConnection ?? 256;
	const maxBody = options.maxRequestBodyBytes ?? 1024 ** 3;
	const authTimeoutMs = options.authTimeoutMs ?? 10_000;
	const allowPrivate = { ...DEFAULT_GUARD, ...options.guard }.allowPrivate;

	const assertAllowedHost = (url: URL) => {
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
			const err: NodeJS.ErrnoException = new Error(`blocked address ${host}`);
			err.code = "EBLOCKED";
			throw err;
		}
	};

	const preconnect = (target: unknown) => {
		if (!isObject(target)) return;
		if (typeof target.origin !== "string") {
			if (typeof target.host === "string") guard.prefetch(target.host);
			return;
		}
		let url: URL;
		try {
			url = new URL(target.origin);
			if (url.protocol !== "http:" && url.protocol !== "https:") return;
			assertAllowedHost(url);
		} catch {
			return;
		}
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		const key = warmKey(url.protocol, url.hostname, port);
		if (
			warm.has(key) ||
			warming.has(key) ||
			warm.size + warming.size >= MAX_WARM
		)
			return;
		warming.add(key);
		baseConnect(
			{ protocol: url.protocol, hostname: url.hostname, host: url.host, port },
			(err, socket) => {
				warming.delete(key);
				if (err || !socket) return;
				const timer = setTimeout(() => {
					dropWarm(key);
					socket.destroy();
				}, WARM_TTL_MS);
				timer.unref();
				socket.on("error", () => {});
				socket.once("close", () => {
					if (warm.get(key)?.socket === socket) dropWarm(key);
				});
				warm.set(key, { socket, timer });
			},
		);
	};

	const server =
		options.server ??
		http.createServer((_, res) =>
			res.writeHead(426).end("ramjet assisted server"),
		);
	const wss = new WebSocketServer({
		server,
		path: options.path ?? "/assisted",
		perMessageDeflate: false,
		maxPayload: 16 * 1024 * 1024,
	});

	wss.on("connection", (socket) => {
		const streams = new Map<number, Stream>();
		let authed = !options.token;
		const send = (frame: Uint8Array) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(frame);
		};
		const sendError = (id: number, error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			send(encodeJson(T.ERROR, id, { message, code }));
		};
		const finish = (id: number) => {
			const s = streams.get(id);
			if (s) s.done = true;
			streams.delete(id);
		};

		const teardown = (s: Stream) => {
			s.done = true;
			s.abort?.();
			s.ws?.terminate();
			s.body?.destroy();
		};
		const fail = (id: number, error: unknown) => {
			const s = streams.get(id);
			if (!s || s.done) return;
			sendError(id, error);
			teardown(s);
			finish(id);
		};
		const authTimer = authed
			? undefined
			: setTimeout(() => socket.close(4401, "unauthorized"), authTimeoutMs);
		authTimer?.unref();

		function startRequest(id: number, info: RequestInfo) {
			const url = new URL(info.url);
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new Error("unsupported protocol");
			assertAllowedHost(url);
			const headers: Record<string, string | string[]> = Object.create(null);
			for (const [name, value] of info.headers) {
				const lower = name.toLowerCase();
				if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
				const existing = headers[lower];
				headers[lower] =
					existing === undefined
						? value
						: Array.isArray(existing)
							? [...existing, value]
							: [existing, value];
			}
			const stream = streams.get(id)!;
			stream.uploadLength = info.bodyLength;
			if (info.bodyLength !== undefined && info.hasBody)
				headers["content-length"] = String(info.bodyLength);

			const body = info.hasBody
				? new PassThrough({ highWaterMark: UPLOAD_CREDIT / 4 })
				: null;
			stream.body = body ?? undefined;

			const handler: Dispatcher.DispatchHandler = {
				onRequestStart(controller) {
					if (stream.done) return controller.abort(new Error("cancelled"));
					stream.abort = () => controller.abort(new Error("cancelled"));
					stream.resume = () => controller.resume();
					stream.pause = () => controller.pause();
				},
				onResponseError(_controller, err) {
					fail(id, err);
				},
				onResponseStart(_controller, status, responseHeaders, statusText) {
					if (stream.done || status < 200) return;

					const out: RawHeaders = [];
					for (const [name, value] of Object.entries(responseHeaders)) {
						if (HOP_BY_HOP.has(name) || value === undefined) continue;
						if (Array.isArray(value))
							for (const v of value) out.push([name, v]);
						else out.push([name, String(value)]);
					}
					send(
						encodeJson(T.RESPONSE, id, {
							status,
							statusText: statusText ?? "",
							headers: out,
						}),
					);
				},
				onResponseData(_controller, chunk: Buffer) {
					if (stream.done) return;
					for (let off = 0; off < chunk.length; off += MAX_CHUNK) {
						const part = chunk.subarray(off, off + MAX_CHUNK);
						send(encodeFrame(T.RESP_BODY, id, part));
						stream.window -= part.length;
					}

					if (stream.window <= 0) stream.pause?.();
				},
				onResponseEnd() {
					if (stream.done) return;
					send(encodeFrame(T.RESP_END, id));
					finish(id);
				},
			};

			agent.dispatch(
				{
					origin: url.origin,
					path: url.pathname + url.search,
					method: info.method as Dispatcher.HttpMethod,
					headers,
					body,
				},
				handler,
			);
		}

		function startWebSocket(id: number, info: WsOpenInfo) {
			const url = new URL(info.url);
			if (url.protocol === "http:") url.protocol = "ws:";
			if (url.protocol === "https:") url.protocol = "wss:";
			if (url.protocol !== "ws:" && url.protocol !== "wss:")
				throw new Error("unsupported protocol");
			assertAllowedHost(url);
			const headers: Record<string, string> = Object.create(null);
			for (const [name, value] of info.headers) {
				const lower = name.toLowerCase();
				if (
					HOP_BY_HOP.has(lower) ||
					lower.startsWith("sec-websocket-") ||
					lower === "host"
				)
					continue;
				headers[name] = value;
			}
			const upstream = new WebSocket(url, info.protocols, {
				headers,
				lookup: guard.lookup as never,
				rejectUnauthorized: !options.insecureTls,
				perMessageDeflate: false,
			});
			const stream = streams.get(id)!;
			stream.ws = upstream;
			upstream.on("open", () =>
				send(
					encodeJson(T.WS_OPENED, id, {
						protocol: upstream.protocol,
						extensions: upstream.extensions,
					}),
				),
			);
			upstream.on("message", (data, isBinary) => {
				const bytes = Array.isArray(data)
					? Buffer.concat(data)
					: Buffer.from(data as ArrayBuffer);
				send(encodeWsData(T.WS_DATA, id, bytes, !isBinary));

				if (socket.bufferedAmount > WS_HIGH_WATER && !upstream.isPaused) {
					upstream.pause();
					const resumeWhenDrained = () => {
						if (stream.done || socket.readyState !== WebSocket.OPEN) return;
						if (socket.bufferedAmount < WS_LOW_WATER) upstream.resume();
						else setTimeout(resumeWhenDrained, 10);
					};
					setTimeout(resumeWhenDrained, 10);
				}
			});
			upstream.on("close", (code, reason) => {
				send(
					encodeJson(T.WS_CLOSED, id, {
						code,
						reason: reason.toString(),
					} satisfies CloseInfo),
				);
				finish(id);
			});
			upstream.on("error", (err) => fail(id, err));
		}

		function open(type: number, id: number, payload: Uint8Array) {
			if (streams.has(id)) return socket.close(4400, "duplicate stream id");
			if (streams.size >= maxStreams)
				return sendError(id, new Error("too many streams"));
			let info: unknown;
			try {
				info = parseJson<unknown>(payload);
			} catch {
				return sendError(id, new Error("malformed request"));
			}
			const valid =
				isObject(info) &&
				typeof info.url === "string" &&
				isHeaders(info.headers) &&
				(type === T.REQUEST
					? typeof info.method === "string" &&
						/^[A-Za-z]+$/.test(info.method) &&
						typeof info.hasBody === "boolean" &&
						(info.bodyLength === undefined ||
							(Number.isSafeInteger(info.bodyLength) &&
								(info.bodyLength as number) >= 0 &&
								(info.bodyLength as number) <= maxBody &&
								(info.hasBody
									? (info.bodyLength as number) > 0
									: info.bodyLength === 0)))
					: Array.isArray(info.protocols) &&
						info.protocols.every((p) => typeof p === "string"));
			if (!valid) return sendError(id, new Error("malformed request"));
			streams.set(id, {
				window: INITIAL_CREDIT,
				done: false,
				uploadOutstanding: UPLOAD_CREDIT,
				uploadUncredited: 0,
				uploaded: 0,
			});
			try {
				if (type === T.REQUEST) {
					const request = info as unknown as RequestInfo;
					startRequest(id, {
						...request,
						method: request.method.toUpperCase(),
					});
				} else startWebSocket(id, info as unknown as WsOpenInfo);
			} catch (error) {
				fail(id, error);
			}
		}

		function handle(frame: { type: number; id: number; payload: Uint8Array }) {
			const { id, payload } = frame;
			if (frame.type === T.HELLO) {
				if (options.token) {
					const hello = parseJson<unknown>(payload);
					const given = Buffer.from(
						isObject(hello) && typeof hello.token === "string"
							? hello.token
							: "",
					);
					const want = Buffer.from(options.token);
					if (given.length !== want.length || !timingSafeEqual(given, want))
						return socket.close(4401, "unauthorized");
				}
				authed = true;
				clearTimeout(authTimer);
				return send(encodeJson(T.HELLO_OK, 0, { maxStreams }));
			}
			if (!authed) return socket.close(4401, "unauthorized");

			switch (frame.type) {
				case T.PING:
					return send(encodeFrame(T.PONG, id));
				case T.PRECONNECT:
					return preconnect(parseJson<unknown>(payload));
				case T.REQUEST:
				case T.WS_OPEN:
					return open(frame.type, id, payload);
				case T.REQ_BODY: {
					const s = streams.get(id);
					if (!s?.body) return;
					const length = payload.byteLength;
					s.uploadOutstanding -= length;
					s.uploaded += length;

					if (s.uploadOutstanding < -MAX_CHUNK)
						return fail(id, new Error("request body exceeded its credit"));
					if (s.uploaded > maxBody)
						return fail(id, new Error("request body too large"));
					if (s.uploadLength !== undefined && s.uploaded > s.uploadLength)
						return fail(id, new Error("request body length mismatch"));
					s.body.write(Buffer.from(payload), () => {
						if (s.done) return;
						s.uploadUncredited += length;
						if (s.uploadUncredited >= UPLOAD_CREDIT / 4) {
							send(encodeCredit(id, s.uploadUncredited, T.REQ_CREDIT));
							s.uploadOutstanding += s.uploadUncredited;
							s.uploadUncredited = 0;
						}
					});
					return;
				}
				case T.REQ_END: {
					const s = streams.get(id);
					if (s?.uploadLength !== undefined && s.uploaded !== s.uploadLength)
						return fail(id, new Error("request body length mismatch"));
					return void s?.body?.end();
				}
				case T.CANCEL: {
					const s = streams.get(id);
					if (s) teardown(s);
					return finish(id);
				}
				case T.CREDIT: {
					const s = streams.get(id);
					if (!s) return;
					s.window += parseCredit(payload);
					if (s.window > 0) s.resume?.();
					return;
				}
				case T.WS_SEND: {
					const { isText, data: body } = decodeWsData(payload);
					const ws = streams.get(id)?.ws;
					if (ws?.readyState === WebSocket.OPEN)
						ws.send(isText ? Buffer.from(body).toString() : Buffer.from(body));
					return;
				}
				case T.WS_CLOSE: {
					const info = parseJson<unknown>(payload);
					const ws = streams.get(id)?.ws;
					if (ws && ws.readyState <= WebSocket.OPEN && isObject(info))
						ws.close(closeCode(info.code), closeReason(info.reason));
					return;
				}
			}
		}

		socket.on("message", (data, isBinary) => {
			if (!isBinary) return;
			try {
				const bytes = Array.isArray(data)
					? Buffer.concat(data)
					: Buffer.from(data as ArrayBuffer);
				const frame = decodeFrame(bytes);
				if (!frame) return socket.close(4400, "malformed frame");
				handle(frame);
			} catch {
				socket.close(4400, "protocol error");
			}
		});

		socket.on("close", () => {
			clearTimeout(authTimer);
			for (const s of streams.values()) teardown(s);
			streams.clear();
		});
		socket.on("error", () => {});
	});

	if (!options.server)
		await new Promise<void>((resolve) =>
			server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
		);
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : 0,
		resetUpstream: async () => {
			const old = agent;
			agent = makeAgent();
			for (const [key, hit] of [...warm]) {
				hit.socket.destroy();
				dropWarm(key);
			}
			await old.close();
		},
		close: async () => {
			for (const client of wss.clients) client.terminate();
			for (const [key, hit] of [...warm]) {
				hit.socket.destroy();
				dropWarm(key);
			}
			wss.close();
			await agent.close();
			if (!options.server)
				await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

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
	type ResponseInfo,
	type WsOpenedInfo,
} from "./protocol.ts";
import { prepareBody } from "./body.ts";

export type WebSocketDataType = Blob | ArrayBuffer | string;
export type FetchBodyType = ReadableStream | ArrayBuffer | Blob | string;
export type TransferrableResponse = {
	body: FetchBodyType;
	headers: RawHeaders;
	status: number;
	statusText: string;
};
export interface ProxyTransport {
	init: () => Promise<void>;
	ready: boolean;
	connect: (
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	) => [
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	];
	request: (
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	) => Promise<TransferrableResponse>;
}

export type AssistedOptions = {
	url: string;
	token?: string;

	pingIntervalMs?: number;
	handshakeTimeoutMs?: number;
	WebSocket?: typeof WebSocket;
};

type Pending = {
	resolve: (r: TransferrableResponse) => void;
	reject: (e: Error) => void;
	method: string;
	signal?: AbortSignal;
	onAbort?: () => void;
	controller?: ReadableStreamDefaultController<Uint8Array>;

	serverWindow: number;
	responded: boolean;

	uploadWindow: number;
	uploadWaiter?: () => void;
};

type Queued = { launch: () => void; reject: (e: Error) => void };

type WsStream = {
	onopen: (protocol: string, extensions: string) => void;
	onmessage: (data: WebSocketDataType) => void;
	onclose: (code: number, reason: string) => void;
	onerror: (error: string) => void;
};

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const textDecoder = new TextDecoder();

function supportedEncodings(): string {
	try {
		new DecompressionStream("brotli" as CompressionFormat);
		return "gzip, deflate, br";
	} catch {
		return "gzip, deflate";
	}
}

function decompress(
	source: ReadableStream<Uint8Array>,
	formats: string[],
): ReadableStream<Uint8Array> {
	let out: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!out) {
				const reader = source.getReader();
				const first = await reader.read();
				if (first.done) return controller.close();
				let body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
					start: (c) => c.enqueue(first.value),
					pull: async (c) => {
						const next = await reader.read();
						if (next.done) c.close();
						else c.enqueue(next.value);
					},
					cancel: (reason) => reader.cancel(reason),
				});
				for (const f of formats) {
					body = body.pipeThrough(
						new DecompressionStream(
							(f === "br"
								? "brotli"
								: f === "x-gzip"
									? "gzip"
									: f) as CompressionFormat,
						) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
					);
				}
				out = body.getReader();
			}
			const next = await out.read();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		cancel: (reason) => (out ? out.cancel(reason) : source.cancel(reason)),
	});
}

export class AssistedTransport implements ProxyTransport {
	ready = false;

	readonly supportsNotModified = true;
	private socket: WebSocket | null = null;
	private connecting: Promise<WebSocket> | null = null;
	private cancelConnecting?: (error: Error) => void;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly queue: Queued[] = [];
	private maxStreams = 256;
	private lastRx = 0;

	readonly stats = { uploadBytesSent: 0 };
	private readonly sockets = new Map<number, WsStream>();
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private readonly acceptEncoding = supportedEncodings();

	private readonly options: AssistedOptions;

	constructor(options: AssistedOptions) {
		const timeout = options.handshakeTimeoutMs ?? 15_000;
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647)
			throw new RangeError(
				"handshakeTimeoutMs must be a positive finite timeout",
			);
		this.options = options;
	}

	async init(): Promise<void> {
		await this.ensureConnected();
	}

	preconnect(target: string): void {
		const message = target.includes("://")
			? { origin: target }
			: { host: target };
		void this.ensureConnected()
			.then((s) => s.send(encodeJson(T.PRECONNECT, 0, message)))
			.catch(() => {});
	}

	private ensureConnected(): Promise<WebSocket> {
		if (this.connecting) return this.connecting;
		if (this.ready && this.socket?.readyState === 1)
			return Promise.resolve(this.socket);
		this.ready = false;
		this.maxStreams = 256;
		const WS = this.options.WebSocket ?? WebSocket;
		const connecting = new Promise<WebSocket>((resolve, reject) => {
			const socket = new WS(this.options.url);
			this.socket = socket;
			socket.binaryType = "arraybuffer";
			let helloDone = false;
			let settled = false;
			const disconnect = (error: Error) => {
				if (this.socket !== socket) return;
				this.socket = null;
				this.ready = false;
				clearInterval(this.pingTimer);
				this.failAll(error);
			};
			const cleanup = () => {
				clearTimeout(timer);
				if (this.cancelConnecting === fail) this.cancelConnecting = undefined;
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				disconnect(error);
				reject(error);
				socket.close();
			};
			const timer = setTimeout(
				() => fail(new Error("assisted transport: handshake timed out")),
				this.options.handshakeTimeoutMs ?? 15_000,
			);
			this.cancelConnecting = fail;
			socket.onopen = () => {
				if (this.socket !== socket || settled) return;
				socket.send(
					encodeJson(
						T.HELLO,
						0,
						this.options.token ? { token: this.options.token } : {},
					),
				);
			};
			socket.onmessage = (event) => {
				if (this.socket !== socket) return;
				if (typeof event.data === "string") return;
				try {
					const frame = decodeFrame(event.data as ArrayBuffer);
					if (!frame) return;
					this.lastRx = Date.now();
					if (!helloDone && frame.type === T.HELLO_OK) {
						const info = parseJson<{ maxStreams?: number }>(frame.payload);
						if (!info || typeof info !== "object" || Array.isArray(info))
							throw new Error(
								"assisted transport: invalid handshake acknowledgement",
							);
						const max = info?.maxStreams;
						if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0))
							throw new Error("assisted transport: invalid stream limit");
						if (max !== undefined) this.maxStreams = max;
						helloDone = settled = true;
						cleanup();
						return resolve(socket);
					}
					if (!helloDone)
						throw new Error(
							"assisted transport: missing handshake acknowledgement",
						);
					this.onFrame(frame.type, frame.id, frame.payload);
				} catch (error) {
					const failure =
						error instanceof Error ? error : new Error(String(error));
					if (!helloDone) fail(failure);
					else {
						disconnect(failure);
						socket.close();
					}
				}
			};
			socket.onerror = () => {
				const error = new Error("assisted transport: connection failed");
				if (!helloDone) fail(error);
				else {
					disconnect(error);
					socket.close();
				}
			};
			socket.onclose = () => {
				if (!helloDone)
					fail(
						new Error(
							"assisted transport: unauthorized or closed during handshake",
						),
					);
				else disconnect(new Error("assisted transport: disconnected"));
			};
		})
			.then((socket) => {
				if (this.socket !== socket || socket.readyState !== 1)
					throw new Error("assisted transport: disconnected");
				this.ready = true;
				const every = this.options.pingIntervalMs ?? 20_000;
				clearInterval(this.pingTimer);
				this.lastRx = Date.now();
				if (every > 0) {
					this.pingTimer = setInterval(() => {
						if (socket.readyState !== 1) return;

						if (Date.now() - this.lastRx > every * 2.5) return socket.close();
						socket.send(encodeFrame(T.PING, 0));
					}, every);
					(this.pingTimer as { unref?: () => void }).unref?.();
				}
				return socket;
			})
			.finally(() => {
				if (this.connecting === connecting) this.connecting = null;
			});
		this.connecting = connecting;
		return connecting;
	}

	close(): void {
		const error = new Error("assisted transport: closed");
		if (this.cancelConnecting) return this.cancelConnecting(error);
		const socket = this.socket;
		this.socket = null;
		this.ready = false;
		clearInterval(this.pingTimer);
		this.failAll(error);
		socket?.close();
	}

	private failAll(error: Error) {
		for (const [id, p] of [...this.pending]) {
			this.release(id);
			p.signal?.removeEventListener("abort", p.onAbort!);
			if (p.responded) p.controller?.error(error);
			else p.reject(error);
		}
		for (const [id, s] of [...this.sockets]) {
			this.sockets.delete(id);
			s.onerror(error.message);
			s.onclose(1006, "transport disconnected");
		}
		for (const queued of this.queue.splice(0)) queued.reject(error);
	}

	private release(id: number): Pending | undefined {
		const p = this.pending.get(id);
		if (!p) return undefined;
		this.pending.delete(id);
		p.uploadWaiter?.();
		this.drain();
		return p;
	}

	private hasRoom(): boolean {
		return this.pending.size + this.sockets.size < this.maxStreams;
	}

	private drain() {
		if (!this.ready) return;
		while (this.queue.length && this.hasRoom()) this.queue.shift()!.launch();
	}

	private onFrame(type: number, id: number, payload: Uint8Array) {
		if (type === T.PONG || type === T.HELLO_OK) return;
		const ws = this.sockets.get(id);
		if (ws) return this.onWsFrame(ws, type, id, payload);

		const p = this.pending.get(id);
		if (!p) return;
		switch (type) {
			case T.RESPONSE:
				return this.onResponse(id, p, parseJson<ResponseInfo>(payload));
			case T.RESP_BODY: {
				p.serverWindow -= payload.byteLength;
				p.controller?.enqueue(payload.slice());
				return;
			}
			case T.REQ_CREDIT:
				p.uploadWindow += parseCredit(payload);
				return p.uploadWaiter?.();
			case T.RESP_END:
				this.release(id);
				p.signal?.removeEventListener("abort", p.onAbort!);
				p.controller?.close();
				return;
			case T.ERROR: {
				const { message } = parseJson<{ message: string }>(payload);
				this.release(id);
				p.signal?.removeEventListener("abort", p.onAbort!);
				const error = new TypeError(message);
				return p.responded ? p.controller?.error(error) : p.reject(error);
			}
		}
	}

	private onResponse(id: number, p: Pending, info: ResponseInfo) {
		p.responded = true;
		let headers = info.headers;
		const encoding =
			headers
				.find(([k]) => k.toLowerCase() === "content-encoding")?.[1]
				?.toLowerCase()
				.trim() ?? "";
		const formats = encoding
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s && s !== "identity")
			.reverse();
		const known = formats.every((f) =>
			["gzip", "x-gzip", "deflate", "br"].includes(f),
		);

		const source = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					p.controller = controller;
				},
				pull: (controller) => {
					const room = controller.desiredSize ?? 0;
					if (room > p.serverWindow && this.socket?.readyState === 1) {
						this.socket.send(encodeCredit(id, room - p.serverWindow));
						p.serverWindow = room;
					}
				},
				cancel: () => {
					if (this.release(id) && this.socket?.readyState === 1)
						this.socket.send(encodeFrame(T.CANCEL, id));
				},
			},
			{ highWaterMark: INITIAL_CREDIT, size: (chunk) => chunk.byteLength },
		);

		let body: ReadableStream<Uint8Array> | null = source;
		if (formats.length && known) {
			body = decompress(body, formats);
			headers = headers.filter(
				([k]) =>
					!["content-encoding", "content-length"].includes(k.toLowerCase()),
			);
		}
		if (NULL_BODY_STATUS.has(info.status) || p.method === "HEAD") {
			void source.cancel().catch(() => {});
			body = null;
		}
		p.resolve({
			body: body as unknown as FetchBodyType,
			headers,
			status: info.status,
			statusText: info.statusText,
		});
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		await this.ensureConnected();
		if (signal?.aborted)
			throw new DOMException("The operation was aborted.", "AbortError");
		const prepared =
			body !== null &&
			body !== undefined &&
			method !== "GET" &&
			method !== "HEAD"
				? await prepareBody(body)
				: undefined;
		if (signal?.aborted) {
			if (prepared?.body instanceof ReadableStream)
				void prepared.body.cancel().catch(() => {});
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		return new Promise<TransferrableResponse>((resolve, reject) => {
			const launch = () => {
				const socket = this.socket;
				if (!socket || socket.readyState !== 1)
					return reject(new Error("assisted transport: disconnected"));
				signal?.removeEventListener("abort", onQueuedAbort);
				const id = this.nextId++ >>> 0;
				const sent: RawHeaders = [];
				let hasEncoding = false;
				for (const [k, v] of headers) {
					if (k.toLowerCase() === "accept-encoding") {
						hasEncoding = true;
						sent.push([k, this.acceptEncoding]);
					} else sent.push([k, v]);
				}
				if (!hasEncoding) sent.push(["Accept-Encoding", this.acceptEncoding]);

				const hasBody = prepared !== undefined && prepared.length !== 0;
				const p: Pending = {
					resolve,
					reject,
					method,
					signal,
					serverWindow: INITIAL_CREDIT,
					responded: false,
					uploadWindow: UPLOAD_CREDIT,
				};
				p.onAbort = () => {
					if (!this.release(id)) return;
					if (this.socket?.readyState === 1)
						this.socket.send(encodeFrame(T.CANCEL, id));
					const error = new DOMException(
						"The operation was aborted.",
						"AbortError",
					);
					p.responded ? p.controller?.error(error) : reject(error);
				};
				signal?.addEventListener("abort", p.onAbort, { once: true });
				this.pending.set(id, p);
				socket.send(
					encodeJson(T.REQUEST, id, {
						method,
						url: remote.href,
						headers: sent,
						hasBody,
						bodyLength: prepared?.length,
					}),
				);
				if (hasBody) void this.sendBody(socket, id, p, prepared!.body);
			};
			const onQueuedAbort = () => {
				const at = this.queue.indexOf(entry);
				if (at >= 0) this.queue.splice(at, 1);
				if (prepared?.body instanceof ReadableStream)
					void prepared.body.cancel().catch(() => {});
				reject(new DOMException("The operation was aborted.", "AbortError"));
			};
			const entry: Queued = { launch, reject };
			if (this.hasRoom()) return launch();

			signal?.addEventListener("abort", onQueuedAbort, { once: true });
			this.queue.push(entry);
		});
	}

	private async sendBody(
		socket: WebSocket,
		id: number,
		p: Pending,
		body: BodyInit,
	) {
		try {
			const stream = new Response(body).body;
			const reader = stream?.getReader();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				for (let off = 0; off < value.byteLength; off += MAX_CHUNK) {
					while (p.uploadWindow <= 0 && this.pending.get(id) === p)
						await new Promise<void>((r) => (p.uploadWaiter = r));
					while (socket.bufferedAmount > 1024 * 1024)
						await new Promise((r) => setTimeout(r, 5));
					if (socket.readyState !== 1 || this.pending.get(id) !== p)
						return void reader.cancel().catch(() => {});
					const chunk = value.subarray(off, off + MAX_CHUNK);
					p.uploadWindow -= chunk.byteLength;
					this.stats.uploadBytesSent += chunk.byteLength;
					socket.send(encodeFrame(T.REQ_BODY, id, chunk));
				}
			}
			if (socket.readyState === 1 && this.pending.get(id) === p)
				socket.send(encodeFrame(T.REQ_END, id));
		} catch (error) {
			const had = this.release(id);
			if (socket.readyState === 1) socket.send(encodeFrame(T.CANCEL, id));
			if (had)
				had.responded
					? had.controller?.error(error)
					: had.reject(error as Error);
		}
	}

	private onWsFrame(
		ws: WsStream,
		type: number,
		id: number,
		payload: Uint8Array,
	) {
		switch (type) {
			case T.WS_OPENED: {
				const info = parseJson<WsOpenedInfo>(payload);
				return ws.onopen(info.protocol, info.extensions);
			}
			case T.WS_DATA: {
				const { isText, data } = decodeWsData(payload);
				return ws.onmessage(
					isText ? textDecoder.decode(data) : data.slice().buffer,
				);
			}
			case T.ERROR: {
				this.sockets.delete(id);
				this.drain();
				ws.onerror(parseJson<{ message: string }>(payload).message);
				return ws.onclose(1006, "");
			}
			case T.WS_CLOSED: {
				this.sockets.delete(id);
				this.drain();
				const info = parseJson<CloseInfo>(payload);
				return ws.onclose(info.code, info.reason);
			}
		}
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: WsStream["onopen"],
		onmessage: WsStream["onmessage"],
		onclose: WsStream["onclose"],
		onerror: WsStream["onerror"],
	): [
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	] {
		const id = this.nextId++ >>> 0;
		this.sockets.set(id, { onopen, onmessage, onclose, onerror });
		const opened = this.ensureConnected().then((socket) => {
			socket.send(
				encodeJson(T.WS_OPEN, id, {
					url: url.href,
					protocols,
					headers: requestHeaders,
				}),
			);
			return socket;
		});
		opened.catch((error) => {
			if (this.sockets.delete(id)) {
				onerror(String(error?.message ?? error));
				onclose(1006, "");
			}
		});

		const send = (data: WebSocketDataType) => {
			void (async () => {
				const socket = await opened;
				if (typeof data === "string")
					return socket.send(
						encodeWsData(T.WS_SEND, id, new TextEncoder().encode(data), true),
					);
				const bytes =
					data instanceof Blob
						? new Uint8Array(await data.arrayBuffer())
						: new Uint8Array(data);
				socket.send(encodeWsData(T.WS_SEND, id, bytes, false));
			})().catch(() => {});
		};
		const close = (code: number, reason: string) => {
			void opened
				.then((socket) =>
					socket.send(encodeJson(T.WS_CLOSE, id, { code, reason })),
				)
				.catch(() => {});
		};
		return [send, close];
	}
}

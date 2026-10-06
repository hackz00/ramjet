import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistedTransport } from "../src/client.ts";
import { T, decodeFrame, encodeJson } from "../src/protocol.ts";

class Socket {
	readyState = 0;
	binaryType = "";
	onopen?: () => void;
	onclose?: () => void;
	onerror?: () => void;
	onmessage?: (event: { data: ArrayBuffer }) => void;
	frames: ReturnType<typeof decodeFrame>[] = [];
	send(data: Uint8Array) {
		this.frames.push(decodeFrame(data));
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	message(type: number, id = 0, info: unknown = {}) {
		const data = encodeJson(type, id, info);
		this.onmessage?.({
			data: data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			) as ArrayBuffer,
		});
	}
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

function setup(timeout = 1000) {
	const sockets: Socket[] = [];
	class TestSocket extends Socket {
		constructor() {
			super();
			sockets.push(this);
		}
	}
	const transport = new AssistedTransport({
		url: "ws://fixture.invalid/assisted",
		WebSocket: TestSocket as unknown as typeof WebSocket,
		pingIntervalMs: 0,
		handshakeTimeoutMs: timeout,
	});
	return { transport, sockets };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("all callers share the handshake and wait for acknowledgement", async () => {
	const { transport, sockets } = setup();
	const init = transport.init();
	const socket = sockets[0];
	socket.open();
	const request = transport.request(
		new URL("https://example.com/"),
		"GET",
		null,
		[],
		undefined,
	);
	const rejected = assert.rejects(request, /closed/);
	transport.preconnect("https://example.com");
	transport.connect(
		new URL("wss://example.com/"),
		[],
		[],
		() => {},
		() => {},
		() => {},
		() => {},
	);
	const secondInit = transport.init();
	await tick();
	assert.equal(sockets.length, 1);
	assert.deepEqual(
		socket.frames.map((f) => f!.type),
		[T.HELLO],
	);
	assert.equal(transport.ready, false);
	socket.message(T.HELLO_OK, 0, { maxStreams: 2 });
	await Promise.all([init, secondInit]);
	await tick();
	assert.equal(transport.ready, true);
	for (const type of [T.REQUEST, T.PRECONNECT, T.WS_OPEN])
		assert.ok(socket.frames.some((f) => f!.type === type));
	transport.close();
	await rejected;
	assert.equal(transport.ready, false);
});

test("a missing acknowledgement times out and the next attempt can reconnect", async () => {
	const { transport, sockets } = setup(20);
	const init = transport.init();
	sockets[0].open();
	await assert.rejects(init, /handshake timed out/);
	assert.equal(sockets[0].readyState, 3);
	assert.equal(transport.ready, false);
	const retry = transport.init();
	sockets[1].open();
	sockets[1].message(T.HELLO_OK);
	await retry;
	assert.equal(transport.ready, true);
	transport.close();
});

test("closing during a handshake rejects it immediately", async () => {
	const { transport, sockets } = setup();
	const init = transport.init();
	transport.close();
	await assert.rejects(init, /closed/);
	assert.equal(sockets[0].readyState, 3);
	assert.equal(transport.ready, false);
});

test("disconnects clear readiness and stale socket events cannot break a replacement", async () => {
	const { transport, sockets } = setup();
	const init = transport.init();
	const old = sockets[0];
	old.open();
	old.message(T.HELLO_OK);
	await init;
	old.close();
	assert.equal(transport.ready, false);
	const retry = transport.init();
	const replacement = sockets[1];
	replacement.open();
	replacement.message(T.HELLO_OK);
	await retry;
	old.onerror?.();
	old.onclose?.();
	old.message(T.HELLO_OK);
	assert.equal(transport.ready, true);
	assert.equal(replacement.readyState, 1);
	transport.close();
});

test("errors and invalid acknowledgements fail without leaving a usable socket", async () => {
	for (const failure of ["error", "bad-json", "limit"] as const) {
		const { transport, sockets } = setup();
		const init = transport.init();
		sockets[0].open();
		if (failure === "error") sockets[0].onerror?.();
		else if (failure === "bad-json")
			sockets[0].message(T.HELLO_OK, 0, "not an object");
		else sockets[0].message(T.HELLO_OK, 0, { maxStreams: 0 });
		await assert.rejects(init);
		assert.equal(transport.ready, false);
		assert.equal(sockets[0].readyState, 3);
	}
});

test("handshake deadlines must be valid timers", () => {
	for (const timeout of [0, -1, NaN, Infinity, 2_147_483_648])
		assert.throws(() => setup(timeout), RangeError);
});

test("a socket closed immediately after acknowledgement cannot become ready", async () => {
	const { transport, sockets } = setup();
	const init = transport.init();
	sockets[0].open();
	sockets[0].message(T.HELLO_OK);
	sockets[0].close();
	await assert.rejects(init, /disconnected/);
	assert.equal(transport.ready, false);
});

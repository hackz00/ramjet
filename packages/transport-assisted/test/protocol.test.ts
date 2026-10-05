import { test } from "node:test";
import assert from "node:assert/strict";
import {
	T,
	decodeFrame,
	decodeWsData,
	encodeCredit,
	encodeFrame,
	encodeJson,
	encodeWsData,
	parseCredit,
	parseJson,
} from "../src/protocol.ts";

test("frame round-trips type, id and payload", () => {
	const frame = decodeFrame(encodeFrame(T.RESP_BODY, 0xfffffffe, new Uint8Array([1, 2, 3])))!;
	assert.equal(frame.type, T.RESP_BODY);
	assert.equal(frame.id, 0xfffffffe);
	assert.deepEqual([...frame.payload], [1, 2, 3]);
});

test("an empty payload is allowed and short frames are rejected", () => {
	assert.equal(decodeFrame(encodeFrame(T.REQ_END, 7))!.payload.byteLength, 0);
	assert.equal(decodeFrame(new Uint8Array([1, 2, 3])), null);
});

test("json payloads keep unicode and duplicate header names in order", () => {
	const info = { method: "GET", url: "https://exämple.test/", headers: [["a", "1"], ["a", "2"]], hasBody: false };
	const frame = decodeFrame(encodeJson(T.REQUEST, 9, info))!;
	assert.deepEqual(parseJson(frame.payload), info);
});

test("credit round-trips a 32-bit value", () => {
	const frame = decodeFrame(encodeCredit(3, 4_000_000_000))!;
	assert.equal(frame.type, T.CREDIT);
	assert.equal(parseCredit(frame.payload), 4_000_000_000);
});

test("websocket data keeps the text/binary flag", () => {
	const text = decodeWsData(decodeFrame(encodeWsData(T.WS_DATA, 1, new TextEncoder().encode("hi"), true))!.payload);
	assert.equal(text.isText, true);
	assert.equal(new TextDecoder().decode(text.data), "hi");
	const bin = decodeWsData(decodeFrame(encodeWsData(T.WS_SEND, 1, new Uint8Array([0, 255]), false))!.payload);
	assert.equal(bin.isText, false);
	assert.deepEqual([...bin.data], [0, 255]);
});

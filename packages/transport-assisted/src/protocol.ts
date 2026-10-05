export const T = {
	HELLO: 0x00,
	REQUEST: 0x01,
	REQ_BODY: 0x02,
	REQ_END: 0x03,
	CANCEL: 0x04,

	CREDIT: 0x05,

	PRECONNECT: 0x06,
	PING: 0x07,
	WS_OPEN: 0x10,

	WS_SEND: 0x12,
	WS_CLOSE: 0x13,

	HELLO_OK: 0x80,
	RESPONSE: 0x81,
	RESP_BODY: 0x82,
	RESP_END: 0x83,
	ERROR: 0x84,

	REQ_CREDIT: 0x85,
	PONG: 0x87,
	WS_OPENED: 0x91,
	WS_DATA: 0x92,
	WS_CLOSED: 0x93,
} as const;

export type MessageType = (typeof T)[keyof typeof T];

export type RawHeaders = [string, string][];

export type RequestInfo = {
	method: string;
	url: string;
	headers: RawHeaders;
	hasBody: boolean;

	bodyLength?: number;
};

export type ResponseInfo = {
	status: number;
	statusText: string;
	headers: RawHeaders;
};

export type WsOpenInfo = {
	url: string;
	protocols: string[];
	headers: RawHeaders;
};
export type WsOpenedInfo = { protocol: string; extensions: string };
export type CloseInfo = { code: number; reason: string };

export const INITIAL_CREDIT = 256 * 1024;

export const UPLOAD_CREDIT = 1024 * 1024;

export const MAX_CHUNK = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(
	type: MessageType,
	id: number,
	payload?: Uint8Array,
): Uint8Array {
	const length = payload ? payload.byteLength : 0;
	const out = new Uint8Array(5 + length);
	out[0] = type;
	new DataView(out.buffer).setUint32(1, id >>> 0, false);
	if (payload) out.set(payload, 5);
	return out;
}

export function encodeJson(
	type: MessageType,
	id: number,
	value: unknown,
): Uint8Array {
	return encodeFrame(type, id, encoder.encode(JSON.stringify(value)));
}

export function encodeCredit(
	id: number,
	bytes: number,
	type: MessageType = T.CREDIT,
): Uint8Array {
	const payload = new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, bytes >>> 0, false);
	return encodeFrame(type, id, payload);
}

export type Frame = { type: number; id: number; payload: Uint8Array };

export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame | null {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.byteLength < 5) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		type: bytes[0],
		id: view.getUint32(1, false),
		payload: bytes.subarray(5),
	};
}

export function parseJson<T>(payload: Uint8Array): T {
	return JSON.parse(decoder.decode(payload)) as T;
}

export function parseCredit(payload: Uint8Array): number {
	if (payload.byteLength < 4) return 0;
	return new DataView(
		payload.buffer,
		payload.byteOffset,
		payload.byteLength,
	).getUint32(0, false);
}

export function encodeWsData(
	type: MessageType,
	id: number,
	data: Uint8Array,
	isText: boolean,
): Uint8Array {
	const payload = new Uint8Array(1 + data.byteLength);
	payload[0] = isText ? 1 : 0;
	payload.set(data, 1);
	return encodeFrame(type, id, payload);
}

export function decodeWsData(payload: Uint8Array): {
	isText: boolean;
	data: Uint8Array;
} {
	return { isText: payload[0] === 1, data: payload.subarray(1) };
}

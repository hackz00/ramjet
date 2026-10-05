import { describe, expect, it } from "vitest";
import { needsZeroContentLength, prepareUpload } from "../src/fetch/upload";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamOf(parts: (Uint8Array | string)[], delayMs = 0, finish = true) {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i < parts.length) {
				if (delayMs) await sleep(delayMs);
				const part = parts[i++];
				controller.enqueue(typeof part === "string" ? enc.encode(part) : part);
			} else if (finish) controller.close();
			else await new Promise(() => {});
		},
	});
}

async function drain(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out += dec.decode(value, { stream: true });
	}
}

describe("prepareUpload", () => {
	it("passes through everything that is not a stream", async () => {
		const buffer = new ArrayBuffer(4);
		expect(await prepareUpload(buffer)).toBe(buffer);
		expect(await prepareUpload("text")).toBe("text");
		expect(await prepareUpload(null)).toBeNull();
	});

	it("collects a small stream that ends quickly into one chunk of known length", async () => {
		const out = await prepareUpload(streamOf(["he", "llo ", "world"]));
		expect(out).toBeInstanceOf(Uint8Array);
		expect(dec.decode(out as Uint8Array)).toBe("hello world");
		expect((out as Uint8Array).byteLength).toBe(11);
	});

	it("turns an empty stream into an empty body", async () => {
		const out = (await prepareUpload(streamOf([]))) as Uint8Array;
		expect(out.byteLength).toBe(0);
	});

	it("keeps a slow upload streaming without losing or reordering bytes", async () => {
		const out = await prepareUpload(
			streamOf(["a", "b", "c", "d", "e", "f"], 15),
		);
		expect(out).toBeInstanceOf(ReadableStream);
		expect(await drain(out as ReadableStream<Uint8Array>)).toBe("abcdef");
	});

	it("keeps a large upload streaming", async () => {
		const big = new Uint8Array(200 * 1024).fill(65);
		const out = await prepareUpload(streamOf([big, "tail"]));
		expect(out).toBeInstanceOf(ReadableStream);
		const text = await drain(out as ReadableStream<Uint8Array>);
		expect(text.length).toBe(200 * 1024 + 4);
		expect(text.endsWith("AAAtail")).toBe(true);
	});

	it("does not wait for a stream that never ends: it returns a stream after the probe window", async () => {
		const started = performance.now();
		const out = await prepareUpload(streamOf(["first"], 0, false));
		expect(performance.now() - started).toBeLessThan(500);
		expect(out).toBeInstanceOf(ReadableStream);
		const reader = (out as ReadableStream<Uint8Array>).getReader();
		expect(dec.decode((await reader.read()).value)).toBe("first");
		await reader.cancel();
	});

	it("rejects and cancels the source when the stream errors or carries non-bytes", async () => {
		const failing = new ReadableStream<Uint8Array>({
			start: (c) => c.error(new Error("boom")),
		});
		await expect(prepareUpload(failing)).rejects.toThrow("boom");
		const wrong = new ReadableStream<unknown>({
			start: (c) => (c.enqueue("not bytes"), c.close()),
		});
		await expect(prepareUpload(wrong)).rejects.toThrow(TypeError);
	});
});

describe("needsZeroContentLength", () => {
	it("is true for an empty POST / PUT / PATCH body, however it is empty", () => {
		for (const method of ["POST", "put", "Patch"]) {
			expect(needsZeroContentLength(method, null)).toBe(true);
			expect(needsZeroContentLength(method, undefined)).toBe(true);
			expect(needsZeroContentLength(method, "")).toBe(true);
			expect(needsZeroContentLength(method, new Uint8Array(0))).toBe(true);
			expect(needsZeroContentLength(method, new ArrayBuffer(0))).toBe(true);
			expect(needsZeroContentLength(method, new Blob([]))).toBe(true);
		}
	});

	it("is false when there is a body, and for methods that carry none", () => {
		expect(needsZeroContentLength("POST", "x")).toBe(false);
		expect(needsZeroContentLength("POST", new Uint8Array(3))).toBe(false);
		expect(needsZeroContentLength("POST", new ReadableStream())).toBe(false);
		for (const method of ["GET", "HEAD", "DELETE", "OPTIONS"])
			expect(needsZeroContentLength(method, null)).toBe(false);
	});
});

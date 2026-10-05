import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareBody } from "../src/body.ts";

test("known bodies report UTF-8 and view byte lengths", async () => {
	for (const body of ["héllo", new Blob(["héllo"]), new Uint8Array([0, 1, 2]).subarray(1)]) {
		const result = await prepareBody(body);
		assert.equal(result.length, (await new Response(result.body).arrayBuffer()).byteLength);
	}
});

test("small completed streams report an exact length and retain every byte", async () => {
	const result = await prepareBody(new ReadableStream({ start(c) {
		c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close();
	} }));
	assert.equal(result.length, 3);
	assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [1, 2, 3]);
});

test("an empty stream is identified as a zero-byte body", async () => {
	const result = await prepareBody(new ReadableStream({ start(c) { c.close(); } }));
	assert.equal(result.length, 0);
});

test("large streams keep streaming without dropping the prefetched chunk", async () => {
	const bytes = new Uint8Array(128 * 1024).fill(17);
	const result = await prepareBody(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
	assert.equal(result.length, undefined);
	assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes);
});

test("a stalled producer does not delay dispatch until its next chunk", async () => {
	let producer: ReadableStreamDefaultController<Uint8Array>;
	const prepared = prepareBody(new ReadableStream<Uint8Array>({ start(c) { producer = c; } }));
	let timer: ReturnType<typeof setTimeout>;
	const result = await Promise.race([prepared, new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("body preparation hung")), 500);
	})]).finally(() => clearTimeout(timer));
	assert.equal(result.length, undefined);
	producer!.enqueue(new Uint8Array([9])); producer!.close();
	assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [9]);
});

test("cancelling a probed stream cancels the original producer", async () => {
	let cancelled = false;
	const result = await prepareBody(new ReadableStream({ cancel() { cancelled = true; } }));
	await (result.body as ReadableStream).cancel();
	assert.equal(cancelled, true);
});

test("invalid body chunks reject rather than being coerced into Blob text", async () => {
	await assert.rejects(prepareBody(new ReadableStream({ start(c) { c.enqueue("invalid"); c.close(); } })), TypeError);
});

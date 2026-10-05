import { describe, expect, it } from "vitest";
import { DomHandler } from "domhandler";
import { StreamingHtmlRewriter } from "@rewriters/html-stream";
import { streamHtmlResponse } from "../src/fetch/stream-html";
import {
	context,
	htmlcontext,
	newMeta,
	reference,
	script,
} from "./html-fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encoder = new TextEncoder();

function newRewriter() {
	const meta = newMeta();
	return new StreamingHtmlRewriter(context, meta, htmlcontext, () =>
		context.interface.getInjectScripts(
			meta,
			new DomHandler(),
			htmlcontext,
			script,
		),
	);
}

const prefetcher = { schedule: () => {} } as any;

function upstream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const seen: { cancelled?: unknown } = {};
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel(reason) {
			seen.cancelled = reason ?? "cancelled";
		},
	});
	return {
		body,
		seen,
		push: (bytes: Uint8Array | string) =>
			controller.enqueue(
				typeof bytes === "string" ? encoder.encode(bytes) : bytes,
			),
		end: () => controller.close(),
		fail: (error: unknown) => controller.error(error),
	};
}

const respond = (
	body: ReadableStream<Uint8Array>,
	contentType: string | null,
) =>
	({
		body,
		headers: new Headers(contentType ? { "content-type": contentType } : {}),
	}) as any;

const stream = (body: ReadableStream<Uint8Array>, contentType: string | null) =>
	streamHtmlResponse(
		respond(body, contentType),
		newRewriter(),
		{} as any,
		prefetcher,
	);

async function readAll(
	out: ReadableStream<Uint8Array>,
	encoding = "utf-8",
): Promise<string> {
	return new TextDecoder(encoding).decode(
		await new Response(out).arrayBuffer(),
	);
}

const withTimeout = <T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | "timeout"> =>
	Promise.race([promise, sleep(ms).then(() => "timeout" as const)]);

const DOC = `<!doctype html><html><head><meta charset="utf-8"><title>日本語 😀</title><link rel="stylesheet" href="/a.css"></head><body><p class="x">héllo wörld 日本語 😀</p><a href="/p?q=ü">link</a><script>var u = location.href;</script></body></html>`;

describe("streamHtmlResponse", () => {
	it("flushes the head after the first chunk when Content-Type declares the charset", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html; charset=utf-8");
		up.push(`<!doctype html><html><head><title>t</title></head><body><p>first`);

		const response = await withTimeout(pending, 500);
		expect(response).not.toBe("timeout");
		const out = (response as ReadableStream<Uint8Array>).getReader();
		const first = await withTimeout(out.read(), 500);
		expect(first).not.toBe("timeout");
		const text = new TextDecoder().decode(
			(first as ReadableStreamReadResult<Uint8Array>).value,
		);
		expect(text).toContain("<title>t</title>");
		expect(text).toContain("ramjet-injected");
		expect(text).toContain("<p>first");
		up.push("</p></body></html>");
		up.end();
		let rest = "";
		for (;;) {
			const { done, value } = await out.read();
			if (done) break;
			rest += new TextDecoder().decode(value);
		}
		expect(text + rest).toBe(
			reference(
				`<!doctype html><html><head><title>t</title></head><body><p>first</p></body></html>`,
			),
		);
	});

	it("without a declared charset it waits for the prescan window (1 KB) or the end of the document", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html");
		up.push(
			`<html><head><meta charset="utf-8"><title>t</title></head><body><p>x`,
		);
		expect(await withTimeout(pending, 150)).toBe("timeout");
		up.push("y".repeat(1100));
		const response = await withTimeout(pending, 500);
		expect(response).not.toBe("timeout");
		const got = await withTimeout(
			(response as ReadableStream<Uint8Array>).getReader().read(),
			500,
		);
		expect(got).not.toBe("timeout");
	});

	it("a short document without a charset is flushed when the upstream ends", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html");
		up.push("<html><body>short</body></html>");
		up.end();
		expect(await readAll(await pending)).toBe(
			reference("<html><body>short</body></html>"),
		);
	});

	it("matches the DOM rewriter when the transport delivers the document one byte at a time", async () => {
		for (const contentType of ["text/html; charset=utf-8", "text/html"]) {
			const up = upstream();
			const pending = stream(up.body, contentType);
			const bytes = encoder.encode(DOC);
			for (let i = 0; i < bytes.length; i++) up.push(bytes.subarray(i, i + 1));
			up.end();
			expect(await readAll(await pending), contentType).toBe(reference(DOC));
		}
	});

	it("keeps multi-byte characters intact when chunk boundaries fall inside them", async () => {
		const text = "<p>" + "日本語😀é".repeat(300) + "</p>";
		const bytes = encoder.encode(text);
		for (const size of [1, 2, 3, 5, 1023, 1025]) {
			const up = upstream();
			const pending = stream(up.body, "text/html; charset=utf-8");
			for (let i = 0; i < bytes.length; i += size)
				up.push(bytes.subarray(i, i + size));
			up.end();
			expect(await readAll(await pending), `chunk ${size}`).toBe(
				reference(text),
			);
		}
	});

	it("decodes with the declared charset, and a byte-order mark overrides it", async () => {
		const latin1 = Uint8Array.from([
			...encoder.encode("<p>caf"),
			0xe9,
			...encoder.encode("</p>"),
		]);
		const upA = upstream();
		const a = stream(upA.body, "text/html; charset=iso-8859-1");
		upA.push(latin1);
		upA.end();
		expect(await readAll(await a)).toBe(reference("<p>café</p>"));

		const utf8 = encoder.encode("<p>café</p>");
		const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]);
		const upB = upstream();
		const b = stream(upB.body, "text/html; charset=iso-8859-1");
		upB.push(bom);
		upB.end();
		expect(await readAll(await b)).toBe(reference("<p>café</p>"));
	});

	it("sniffs a meta charset when the header declares none", async () => {
		const html = Uint8Array.from([
			...encoder.encode(
				'<html><head><meta charset="windows-1252"></head><body>caf',
			),
			0xe9,
			...encoder.encode("</body></html>"),
		]);
		const up = upstream();
		const pending = stream(up.body, "text/html");
		up.push(html);
		up.end();
		expect(await readAll(await pending)).toBe(
			reference(
				'<html><head><meta charset="windows-1252"></head><body>café</body></html>',
			),
		);
	});

	it("an empty body produces an empty, closed stream", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html; charset=utf-8");
		up.end();
		expect(await readAll(await pending)).toBe(reference(""));
	});

	it("cancelling the output cancels the upstream download", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html; charset=utf-8");
		up.push("<html><body>start");
		const out = (await pending).getReader();
		await out.read();
		await out.cancel("navigated away");
		expect(up.seen.cancelled).toBe("navigated away");
	});

	it("an upstream error after the head was flushed errors the output instead of hanging", async () => {
		const up = upstream();
		const pending = stream(up.body, "text/html; charset=utf-8");
		up.push("<html><head></head><body>start");
		const out = (await pending).getReader();
		await out.read();
		up.fail(new Error("connection reset"));
		await expect(out.read()).rejects.toThrow("connection reset");
	});

	it("truncated documents end cleanly and match the DOM rewriter", async () => {
		for (const html of [
			`<html><body><p>hi <a href="/x`,
			`<html><body><script>var a = 1;`,
			`<html><body><!-- unfinished`,
		]) {
			const up = upstream();
			const pending = stream(up.body, "text/html; charset=utf-8");
			for (let i = 0; i < html.length; i += 4) up.push(html.slice(i, i + 4));
			up.end();
			expect(await readAll(await pending), html).toBe(reference(html));
		}
	});
});

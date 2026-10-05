import { describe, expect, it } from "vitest";
import { Preconnector } from "../src/fetch/preconnect";
import type { PrefetchHint } from "../src/shared/rewriters/hints";

const PREFIX = "http://p.test/~/sj/f1/";
const context = { prefix: new URL(PREFIX), interface: { codecDecode: (s: string) => decodeURIComponent(s) } } as any;
const hint = (real: string, destination: RequestDestination = "script"): PrefetchHint => ({
	url: PREFIX + encodeURIComponent(real),
	destination,
	mode: "no-cors",
});

function setup(enabled = true, supported = true) {
	const calls: string[] = [];
	const transport = supported ? { preconnect: (o: string) => void calls.push(o) } : {};
	return { calls, p: new Preconnector(() => transport, () => context, enabled) };
}
const doc = new URL("https://site.test/index.html");

describe("Preconnector", () => {
	it("warms each new origin named by the hints, once", () => {
		const { calls, p } = setup();
		p.observe(doc, [hint("https://cdn.test/a.js"), hint("https://cdn.test/b.css", "style"), hint("https://img.test/x.png", "image")]);
		expect(calls).toEqual(["https://cdn.test", "https://img.test"]);
		p.observe(doc, [hint("https://cdn.test/c.js")]);
		expect(calls).toHaveLength(2);
	});

	it("skips the document's own origin, non-http URLs and URLs outside the proxy prefix", () => {
		const { calls, p } = setup();
		p.observe(doc, [hint("https://site.test/own.js"), hint("data:text/plain,x"), { url: "http://other.test/raw.js", destination: "script", mode: "no-cors" }]);
		expect(calls).toEqual([]);
	});

	it("keeps ports and schemes distinct", () => {
		const { calls, p } = setup();
		p.observe(doc, [hint("https://cdn.test:8443/a.js"), hint("http://cdn.test/a.js"), hint("https://cdn.test/a.js")]);
		expect(calls).toEqual(["https://cdn.test:8443", "http://cdn.test", "https://cdn.test"]);
	});

	it("caps how many origins one document can warm", () => {
		const { calls, p } = setup();
		p.observe(doc, Array.from({ length: 20 }, (_, i) => hint(`https://t${i}.test/a.js`)));
		expect(calls).toHaveLength(6);
	});

	it("does nothing when disabled or when the transport cannot preconnect", () => {
		const off = setup(false);
		off.p.observe(doc, [hint("https://cdn.test/a.js")]);
		expect(off.calls).toEqual([]);
		const unsupported = setup(true, false);
		expect(() => unsupported.p.observe(doc, [hint("https://cdn.test/a.js")])).not.toThrow();
		expect(unsupported.p.stats.requested).toBe(0);
	});

	it("survives a transport that throws", () => {
		const p = new Preconnector(() => ({ preconnect: () => { throw new Error("closed"); } }), () => context);
		expect(() => p.observe(doc, [hint("https://cdn.test/a.js")])).not.toThrow();
	});
});

describe("defaults", () => {
	it("preconnect is opt-in (measured gain was within noise)", async () => {
		const { DEFAULT_PREFETCH_OPTIONS } = await import("../src/fetch/prefetch");
		expect(DEFAULT_PREFETCH_OPTIONS.preconnect).toBe(false);
		expect(DEFAULT_PREFETCH_OPTIONS.enabled).toBe(false);
	});
});

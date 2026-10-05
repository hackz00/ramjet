import { describe, expect, it } from "vitest";
import {
	FRESH_UNTIL_HEADER,
	TOKEN_HEADER,
	cacheNameFor,
	findRevalidatable,
	freshnessLifetimeMs,
	lookupOutputCache,
	normalizeRequestUrl,
	planStore,
	refreshFromNotModified,
	storeOutput,
	sweepOutputCache,
	type RequestShape,
} from "../src/output-cache";

const NOW = 1_000_000_000_000;
const GEN = "g1";
const CONTROLLER = "/~/sj/ctl1/";
const frameUrl = (frame: string, rest = "http%3A%2F%2Fsite.test%2Fa.js?x=1") =>
	`http://p.test${CONTROLLER}${frame}/${rest}`;
const ctx = { controllerPrefix: CONTROLLER, generation: GEN };

function getter(headers: Record<string, string>) {
	const lower = Object.fromEntries(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
	);
	return (name: string) => lower[name.toLowerCase()] ?? null;
}

const req = (overrides: Partial<RequestShape> = {}): RequestShape => ({
	url: frameUrl("frA"),
	method: "GET",
	mode: "no-cors",
	destination: "script",
	cacheMode: "default",
	hasRange: false,
	hasAuthorization: false,
	...overrides,
});

class FakeCache {
	entries = new Map<string, Response>();
	async put(url: string, response: Response) {
		this.entries.set(url, response);
	}
	async match(url: string | Request) {
		const key = typeof url === "string" ? url : url.url;
		return this.entries.get(key)?.clone();
	}
	async keys() {
		return [...this.entries.keys()].map((u) => new Request(u));
	}
	async delete(key: string | Request) {
		return this.entries.delete(typeof key === "string" ? key : key.url);
	}
}
class FakeStorage {
	caches = new Map<string, FakeCache>();
	async keys() {
		return [...this.caches.keys()];
	}
	async delete(name: string) {
		return this.caches.delete(name);
	}
	async open(name: string) {
		if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
		return this.caches.get(name)!;
	}
}

describe("freshnessLifetimeMs", () => {
	it("uses max-age and ignores s-maxage (this is a private cache)", () => {
		expect(
			freshnessLifetimeMs(getter({ "cache-control": "max-age=60" }), NOW),
		).toBe(60_000);
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60, s-maxage=10" }),
				NOW,
			),
		).toBe(60_000);
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "s-maxage=600, max-age=5" }),
				NOW,
			),
		).toBe(5_000);

		expect(
			freshnessLifetimeMs(getter({ "cache-control": "s-maxage=600" }), NOW),
		).toBeNull();
	});

	it("subtracts Age and rejects an already-stale response", () => {
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60", age: "20" }),
				NOW,
			),
		).toBe(40_000);
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60", age: "60" }),
				NOW,
			),
		).toBeNull();
	});

	it("falls back to Expires relative to Date, then to now", () => {
		const date = new Date(NOW).toUTCString();
		const expires = new Date(NOW + 5000).toUTCString();
		expect(freshnessLifetimeMs(getter({ expires, date }), NOW)).toBe(5000);
		expect(freshnessLifetimeMs(getter({ expires }), NOW)).toBeGreaterThan(0);
	});

	it("does not treat immutable as a freshness lifetime by itself", () => {
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "public, immutable" }),
				NOW,
			),
		).toBeNull();
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "public, max-age=31536000, immutable" }),
				NOW,
			),
		).toBe(31_536_000_000);
	});

	it("allows private (this is a per-user cache) but not no-store / no-cache / pragma", () => {
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "private, max-age=30" }),
				NOW,
			),
		).toBe(30_000);
		for (const cc of [
			"no-store",
			"no-cache, max-age=60",
			"max-age=60, no-store",
		]) {
			expect(
				freshnessLifetimeMs(getter({ "cache-control": cc }), NOW),
			).toBeNull();
		}
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60", pragma: "no-cache" }),
				NOW,
			),
		).toBeNull();
	});

	it("uses the browser heuristic (10% of the time since Last-Modified, capped at a day) when nothing explicit is sent", () => {
		const day = 24 * 3600 * 1000;
		const date = new Date(NOW).toUTCString();
		const modified = (ago: number) => new Date(NOW - ago).toUTCString();

		expect(
			freshnessLifetimeMs(
				getter({ date, "last-modified": modified(10 * day) }),
				NOW,
			),
		).toBe(day);
		expect(
			freshnessLifetimeMs(
				getter({ date, "last-modified": modified(20 * 3600 * 1000) }),
				NOW,
			),
		).toBe(2 * 3600 * 1000);

		expect(
			freshnessLifetimeMs(
				getter({ date, "last-modified": modified(1000) }),
				NOW,
			),
		).toBeNull();
		expect(freshnessLifetimeMs(getter({}), NOW)).toBeNull();
	});

	it("never applies the heuristic over explicit or forbidding headers", () => {
		const old = new Date(NOW - 10 * 24 * 3600 * 1000).toUTCString();
		const lm = { "last-modified": old };
		expect(
			freshnessLifetimeMs(getter({ ...lm, "cache-control": "max-age=0" }), NOW),
		).toBeNull();
		expect(
			freshnessLifetimeMs(getter({ ...lm, "cache-control": "no-cache" }), NOW),
		).toBeNull();
		expect(
			freshnessLifetimeMs(getter({ ...lm, "cache-control": "no-store" }), NOW),
		).toBeNull();
		expect(
			freshnessLifetimeMs(
				getter({ ...lm, expires: new Date(NOW - 5000).toUTCString() }),
				NOW,
			),
		).toBeNull();
		expect(
			freshnessLifetimeMs(
				getter({ ...lm, "cache-control": "max-age=60" }),
				NOW,
			),
		).toBe(60_000);
	});

	it("refuses responses that vary on anything except Accept-Encoding", () => {
		for (const vary of [
			"*",
			"Cookie",
			"Accept-Encoding, Origin",
			"authorization",
			"User-Agent",
			"Accept",
			"Accept-Language",
			"Sec-CH-UA",
		]) {
			expect(
				freshnessLifetimeMs(
					getter({ "cache-control": "max-age=60", vary }),
					NOW,
				),
				vary,
			).toBeNull();
		}
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60", vary: "Accept-Encoding" }),
				NOW,
			),
		).toBe(60_000);
		expect(
			freshnessLifetimeMs(
				getter({ "cache-control": "max-age=60", vary: "accept-encoding" }),
				NOW,
			),
		).toBe(60_000);
	});
});

describe("planStore", () => {
	const cc = getter({ "cache-control": "max-age=60" });

	it("plans a store for a fresh 200 sub-resource, keyed by generation and mode", () => {
		expect(planStore(req(), 200, cc, NOW, GEN)).toEqual({
			cacheName: cacheNameFor(GEN, "no-cors", "script"),
			freshUntil: NOW + 60_000,
		});
		expect(planStore(req({ mode: "cors" }), 200, cc, NOW, GEN)?.cacheName).toBe(
			cacheNameFor(GEN, "cors", "script"),
		);
		expect(cacheNameFor(GEN, "cors")).not.toBe(cacheNameFor(GEN, "no-cors"));
		expect(cacheNameFor("g2", "cors")).not.toBe(cacheNameFor(GEN, "cors"));
		expect(cacheNameFor(GEN, "cors", "script")).not.toBe(
			cacheNameFor(GEN, "cors", "image"),
		);
	});

	it("never stores documents, fetch()/XHR, non-GET, ranges, credentials, reloads or non-200s", () => {
		const no = (r: Partial<RequestShape>, status = 200) =>
			planStore(req(r), status, cc, NOW, GEN);
		expect(no({ destination: "document" })).toBeNull();
		expect(no({ destination: "iframe" })).toBeNull();
		expect(no({ destination: "" })).toBeNull();
		for (const worker of [
			"worker",
			"sharedworker",
			"audioworklet",
			"paintworklet",
		])
			expect(no({ destination: worker }), worker).toBeNull();
		expect(no({ method: "POST" })).toBeNull();
		expect(no({ hasRange: true })).toBeNull();
		expect(no({ hasAuthorization: true })).toBeNull();
		expect(no({ cacheMode: "reload" })).toBeNull();
		expect(no({ cacheMode: "no-store" })).toBeNull();
		expect(no({}, 206)).toBeNull();
		expect(no({}, 404)).toBeNull();
	});

	it("skips responses declared larger than the entry limit", () => {
		const big = getter({
			"cache-control": "max-age=60",
			"content-length": String(100 * 1024 * 1024),
		});
		expect(planStore(req(), 200, big, NOW, GEN)).toBeNull();
	});
});

describe("normalizeRequestUrl", () => {
	it("replaces the per-frame id and reports the frame prefix", () => {
		const n = normalizeRequestUrl(frameUrl("frA"), CONTROLLER)!;
		expect(n.framePrefix).toBe("/~/sj/ctl1/frA/");
		expect(n.controllerId).toBe("ctl1");
		expect(n.frameId).toBe("frA");
		expect(n.tokenPrefix).toBe("/~/sj/@RJ@/");
		expect(n.key).toBe(
			"http://p.test/~/sj/@RJ@/http%3A%2F%2Fsite.test%2Fa.js?x=1",
		);
	});

	it("gives the same key for different frames and controllers, a different key for another resource or query", () => {
		const a = normalizeRequestUrl(frameUrl("frA"), CONTROLLER)!.key;
		const b = normalizeRequestUrl(frameUrl("frB"), CONTROLLER)!.key;
		const c = normalizeRequestUrl(
			"http://p.test/~/sj/ctl2/frC/http%3A%2F%2Fsite.test%2Fa.js?x=1",
			"/~/sj/ctl2/",
		)!.key;
		expect(a).toBe(b);
		expect(a).toBe(c);
		expect(
			normalizeRequestUrl(
				frameUrl("frA", "http%3A%2F%2Fsite.test%2Fb.js"),
				CONTROLLER,
			)!.key,
		).not.toBe(a);
		expect(
			normalizeRequestUrl(
				frameUrl("frA", "http%3A%2F%2Fsite.test%2Fa.js?x=2"),
				CONTROLLER,
			)!.key,
		).not.toBe(a);
	});

	it("rejects URLs outside the controller prefix or without a frame segment", () => {
		expect(normalizeRequestUrl("http://p.test/other/x", CONTROLLER)).toBeNull();
		expect(
			normalizeRequestUrl("http://p.test/~/sj/ctl1/noframe", CONTROLLER),
		).toBeNull();
	});
});

describe("store and lookup", () => {
	const plan = () =>
		planStore(req(), 200, getter({ "cache-control": "max-age=60" }), NOW, GEN)!;
	const target = (frame: string, rest?: string) => {
		const n = normalizeRequestUrl(frameUrl(frame, rest), CONTROLLER)!;
		return {
			...plan(),
			key: n.key,
			framePrefix: n.framePrefix,
			tokenPrefix: n.tokenPrefix,
			controllerId: n.controllerId,
			frameId: n.frameId,
		};
	};
	const lookup = (
		storage: FakeStorage,
		frame: string,
		over: Partial<RequestShape> = {},
		now = NOW + 1000,
		rest?: string,
	) =>
		lookupOutputCache(
			storage,
			req({ url: frameUrl(frame, rest), ...over }),
			ctx,
			now,
		);

	it("serves a stored response while fresh, then not once stale", async () => {
		const storage = new FakeStorage();
		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			[["Content-Type", "application/javascript"]],
			"console.log(1)",
		);
		const hit = await lookup(storage, "frA");
		expect(hit).not.toBeNull();
		expect(await hit!.text()).toBe("console.log(1)");
		expect(hit!.headers.get("content-type")).toBe("application/javascript");
		expect(await lookup(storage, "frA", {}, NOW + 61_000)).toBeNull();
	});

	it("reuses an entry for a different frame, rewriting the embedded prefix", async () => {
		const storage = new FakeStorage();
		const body =
			'import("http://p.test/~/sj/ctl1/frA/http%3A%2F%2Fsite.test%2Fdep.js");x("/~/sj/ctl1/frA/y")';
		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			[
				["Content-Type", "application/javascript"],
				["Content-Length", String(body.length)],
			],
			body,
		);
		const hit = await lookup(storage, "frB");
		const text = await hit!.text();
		expect(text).toBe(
			'import("http://p.test/~/sj/ctl1/frB/http%3A%2F%2Fsite.test%2Fdep.js");x("/~/sj/ctl1/frB/y")',
		);
		expect(text).not.toContain("@RJ@");
		expect(text).not.toContain("frA");
		expect(hit!.headers.has("content-length")).toBe(false);
		expect(hit!.headers.has(FRESH_UNTIL_HEADER)).toBe(false);
		expect(hit!.headers.has(TOKEN_HEADER)).toBe(false);
	});

	it("passes bodies without an embedded prefix and binary bodies through untouched", async () => {
		const storage = new FakeStorage();
		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			[["Content-Type", "application/javascript"]],
			"var a=1;",
		);
		const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
		await storeOutput(
			storage,
			{
				...target("frA", "img"),
				cacheName: cacheNameFor(GEN, "no-cors", "image"),
			},
			200,
			"OK",
			[["Content-Type", "image/png"]],
			png.buffer,
		);
		expect(await (await lookup(storage, "frB"))!.text()).toBe("var a=1;");
		const img = await lookup(
			storage,
			"frB",
			{ destination: "image" },
			NOW + 1,
			"img",
		);
		expect(new Uint8Array(await img!.arrayBuffer())).toEqual(png);
	});

	it("stores a Uint8Array script body as text and refuses invalid UTF-8 for text types", async () => {
		const storage = new FakeStorage();
		const ok = new TextEncoder().encode("a=1;/~/sj/ctl1/frA/z");
		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			[["Content-Type", "text/javascript"]],
			ok,
		);
		expect(await (await lookup(storage, "frB"))!.text()).toBe(
			"a=1;/~/sj/ctl1/frB/z",
		);

		const bad = new Uint8Array([0x61, 0xff, 0xfe, 0x62]);
		await storeOutput(
			storage,
			target("frA", "bad"),
			200,
			"OK",
			[["Content-Type", "text/javascript"]],
			bad,
		);
		expect(await lookup(storage, "frA", {}, NOW + 1, "bad")).toBeNull();
	});

	it("keeps CORS and no-CORS entries and different generations apart", async () => {
		const storage = new FakeStorage();
		await storeOutput(storage, target("frA"), 200, "OK", [], "x");
		expect(await lookup(storage, "frA", { mode: "cors" })).toBeNull();
		expect(await lookup(storage, "frA", { mode: "no-cors" })).not.toBeNull();
		const other = await lookupOutputCache(
			storage,
			req(),
			{ controllerPrefix: CONTROLLER, generation: "g2" },
			NOW + 1,
		);
		expect(other).toBeNull();
	});

	it("keeps the same URL requested for different destinations apart", async () => {
		const storage = new FakeStorage();
		await storeOutput(storage, target("frA"), 200, "OK", [], "as-script");
		expect(await lookup(storage, "frA", { destination: "style" })).toBeNull();
		expect(await lookup(storage, "frA", { destination: "image" })).toBeNull();
		expect(await (await lookup(storage, "frA"))!.text()).toBe("as-script");
	});

	it("does not store a text body that still carries the controller or frame id in another form", async () => {
		const storage = new FakeStorage();
		const ct = [["Content-Type", "application/javascript"]] as [
			string,
			string,
		][];

		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			ct,
			'x("\\/~\\/sj\\/ctl1\\/frA\\/y")',
		);
		expect(await lookup(storage, "frA")).toBeNull();
		await storeOutput(
			storage,
			target("frA", "b"),
			200,
			"OK",
			ct,
			'x("%2F~%2Fsj%2Fctl1%2FfrA%2Fy")',
		);
		expect(await lookup(storage, "frA", {}, NOW + 1, "b")).toBeNull();

		await storeOutput(
			storage,
			target("frA", "c"),
			200,
			"OK",
			ct,
			'x("/~/sj/ctl1/frA/y")',
		);
		expect(await lookup(storage, "frB", {}, NOW + 1, "c")).not.toBeNull();
	});

	it("ignores requests that must not be served from cache", async () => {
		const storage = new FakeStorage();
		await storeOutput(storage, target("frA"), 200, "OK", [], "x");
		expect(await lookup(storage, "frA", { hasRange: true })).toBeNull();
		expect(await lookup(storage, "frA", { cacheMode: "reload" })).toBeNull();
		expect(
			await lookup(storage, "frA", { destination: "document" }),
		).toBeNull();
	});

	it("does not throw when storing fails (quota)", async () => {
		const storage = {
			open: async () => ({
				put: async () => {
					throw new DOMException("full", "QuotaExceededError");
				},
			}),
		} as any;
		await expect(
			storeOutput(storage, target("frA"), 200, "OK", [], "body"),
		).resolves.toBeUndefined();
	});

	it("overwrites an entry with a newer one and never trusts a caller-supplied deadline header", async () => {
		const storage = new FakeStorage();
		await storeOutput(
			storage,
			{ ...target("frA"), freshUntil: NOW - 1 },
			200,
			"OK",
			[],
			"old",
		);
		await storeOutput(
			storage,
			target("frA"),
			200,
			"OK",
			[[FRESH_UNTIL_HEADER, "99999999999999"]],
			"new",
		);
		expect(await (await lookup(storage, "frA"))!.text()).toBe("new");
	});
});

describe("sweepOutputCache", () => {
	const base = normalizeRequestUrl(frameUrl("frA"), CONTROLLER)!;
	const t = (key: string, freshUntil: number, generation = GEN) => ({
		...base,
		cacheName: cacheNameFor(generation, "no-cors", "script"),
		freshUntil,
		key,
	});

	it("removes expired entries and caches from older cache formats, but keeps other generations' fresh entries", async () => {
		const storage = new FakeStorage();
		await storeOutput(
			storage,
			t("http://x/stale", NOW - 1),
			200,
			"OK",
			[],
			"s",
			NOW,
		);
		await storeOutput(
			storage,
			t("http://x/fresh", NOW + 1000),
			200,
			"OK",
			[],
			"f",
			NOW,
		);
		await storeOutput(
			storage,
			t("http://x/oldgen", NOW + 1000, "g0"),
			200,
			"OK",
			[],
			"o",
			NOW,
		);
		await storage.open("ramjet-out-v2-g0:cors");
		await storage.open("unrelated-cache");
		expect(await sweepOutputCache(storage, GEN, NOW)).toBe(2);
		const cache = await storage.open(cacheNameFor(GEN, "no-cors", "script"));
		expect([...cache.entries.keys()]).toEqual(["http://x/fresh"]);

		const other = await storage.open(cacheNameFor("g0", "no-cors", "script"));
		expect([...other.entries.keys()]).toEqual(["http://x/oldgen"]);
		expect(storage.caches.has("ramjet-out-v2-g0:cors")).toBe(false);
		expect(storage.caches.has("unrelated-cache")).toBe(true);
	});

	it("keeps the total under the byte budget by evicting the oldest entries first", async () => {
		const storage = new FakeStorage();
		const body = "x".repeat(1000);
		for (let i = 0; i < 5; i++)
			await storeOutput(
				storage,
				t(`http://x/${i}`, NOW + 60_000),
				200,
				"OK",
				[],
				body,
				NOW + i,
			);
		expect(
			await sweepOutputCache(storage, GEN, NOW + 10, { maxBytes: 3500 }),
		).toBe(2);
		const cache = await storage.open(cacheNameFor(GEN, "no-cors", "script"));
		expect([...cache.entries.keys()].sort()).toEqual([
			"http://x/2",
			"http://x/3",
			"http://x/4",
		]);
	});
});

describe("revalidation", () => {
	const ctype: [string, string][] = [
		["Content-Type", "application/javascript"],
	];
	const shape = () => req({ url: frameUrl("frB") });
	const seed = async (
		storage: FakeStorage,
		headers: [string, string][],
		body: string,
		freshUntil: number,
	) => {
		const n = normalizeRequestUrl(frameUrl("frA"), CONTROLLER)!;
		await storeOutput(
			storage,
			{ ...n, cacheName: cacheNameFor(GEN, "no-cors", "script"), freshUntil },
			200,
			"OK",
			headers,
			body,
			NOW,
		);
	};

	it("offers validators only for stale entries that have them", async () => {
		const storage = new FakeStorage();
		await seed(
			storage,
			[
				...ctype,
				["ETag", '"v1"'],
				["Last-Modified", "Wed, 01 Jan 2025 00:00:00 GMT"],
			],
			"a=1",
			NOW + 1000,
		);

		expect(
			await findRevalidatable(storage, shape(), ctx, NOW + 500),
		).toBeNull();
		const stale = await findRevalidatable(storage, shape(), ctx, NOW + 2000);
		expect(stale?.validators).toEqual({
			etag: '"v1"',
			lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
		});

		const bare = new FakeStorage();
		await seed(bare, ctype, "a=1", NOW + 1000);
		expect(await findRevalidatable(bare, shape(), ctx, NOW + 2000)).toBeNull();

		expect(
			await findRevalidatable(
				storage,
				req({ destination: "document" }),
				ctx,
				NOW + 2000,
			),
		).toBeNull();
	});

	it("a 304 refreshes the entry from the new headers and serves the stored body for the requesting frame", async () => {
		const storage = new FakeStorage();
		const body = 'import("/~/sj/ctl1/frA/x")';
		await seed(
			storage,
			[...ctype, ["ETag", '"v1"'], ["Cache-Control", "max-age=1"]],
			body,
			NOW + 1000,
		);
		const stale = (await findRevalidatable(storage, shape(), ctx, NOW + 5000))!;
		const served = (await refreshFromNotModified(
			storage,
			stale,
			[
				["Cache-Control", "max-age=600"],
				["ETag", '"v1"'],
				["Content-Length", "0"],
				["Content-Type", "text/plain"],
			],
			NOW + 5000,
		))!;
		expect(served.status).toBe(200);
		expect(served.body).toBe('import("/~/sj/ctl1/frB/x")');
		const headers = Object.fromEntries(served.headers);
		expect(headers["content-type"]).toBe("application/javascript");
		expect(headers["cache-control"]).toBe("max-age=600");
		expect(headers[FRESH_UNTIL_HEADER]).toBeUndefined();

		const hit = await lookupOutputCache(
			storage,
			req({ url: frameUrl("frC") }),
			ctx,
			NOW + 5000 + 599_000,
		);
		expect(await hit!.text()).toBe('import("/~/sj/ctl1/frC/x")');
		expect(
			await lookupOutputCache(
				storage,
				req({ url: frameUrl("frC") }),
				ctx,
				NOW + 5000 + 601_000,
			),
		).toBeNull();
	});

	it("serves a 304'd entry once but forgets it when the 304 forbids reuse", async () => {
		const storage = new FakeStorage();
		await seed(storage, [...ctype, ["ETag", '"v1"']], "a=1", NOW + 1000);
		const stale = (await findRevalidatable(storage, shape(), ctx, NOW + 5000))!;
		const served = await refreshFromNotModified(
			storage,
			stale,
			[["Cache-Control", "no-store"]],
			NOW + 5000,
		);
		expect(new TextDecoder().decode(served!.body as ArrayBuffer)).toBe("a=1");
		expect(
			await findRevalidatable(storage, shape(), ctx, NOW + 6000),
		).toBeNull();
	});

	it("returns null when the entry disappeared before the 304 arrived", async () => {
		const storage = new FakeStorage();
		await seed(storage, [...ctype, ["ETag", '"v1"']], "a=1", NOW + 1000);
		const stale = (await findRevalidatable(storage, shape(), ctx, NOW + 5000))!;
		storage.caches.clear();
		expect(
			await refreshFromNotModified(storage, stale, [], NOW + 5000),
		).toBeNull();
	});

	it("serves binary entries as bytes", async () => {
		const storage = new FakeStorage();
		const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
		const n = normalizeRequestUrl(frameUrl("frA"), CONTROLLER)!;
		await storeOutput(
			storage,
			{
				...n,
				cacheName: cacheNameFor(GEN, "no-cors", "image"),
				freshUntil: NOW + 1000,
			},
			200,
			"OK",
			[
				["Content-Type", "image/png"],
				["ETag", '"i"'],
			],
			png.buffer,
			NOW,
		);
		const imgReq = req({ url: frameUrl("frB"), destination: "image" });
		const stale = (await findRevalidatable(storage, imgReq, ctx, NOW + 5000))!;
		const served = (await refreshFromNotModified(
			storage,
			stale,
			[["Cache-Control", "max-age=60"]],
			NOW + 5000,
		))!;
		expect(new Uint8Array(served.body as ArrayBuffer)).toEqual(png);
	});
});

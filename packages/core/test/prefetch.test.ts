import { describe, expect, it, vi } from "vitest";
import { Prefetcher } from "@/fetch/prefetch";
import { RamjetHeaders } from "@/shared/headers";
import type { PrefetchHint } from "@rewriters/hints";

const PREFIX = "http://proxy.test/~/sj/";
const u = (name: string, q = "") =>
	`${PREFIX}${encodeURIComponent("http://site.test/" + name)}${q}`;

function source(overrides: Record<string, unknown> = {}) {
	const headers = new RamjetHeaders();
	headers.set("User-Agent", "UA");
	headers.set("Accept-Language", "en");
	headers.set("Sec-Fetch-Dest", "document");
	headers.set("Upgrade-Insecure-Requests", "1");
	return {
		rawUrl: new URL(u("page.html")),
		rawReferrer: null,
		rawDestination: "document",
		mode: "navigate",
		referrer: "",
		method: "GET",
		body: null,
		cache: "default",
		initialHeaders: headers,
		clientId: "client-1",
		...overrides,
	} as any;
}

function realRequest(
	url: string,
	destination = "image",
	mode = "no-cors",
	extra: Record<string, unknown> = {},
) {
	return {
		request: {
			rawUrl: new URL(url),
			method: "GET",
			cache: "default",
			body: null,
			mode,
			initialHeaders: new RamjetHeaders(),
			...extra,
		} as any,
		parsed: { destination } as any,
	};
}

const ok = (body: any = "body") => ({
	status: 200,
	statusText: "OK",
	headers: new RamjetHeaders(),
	body,
});

function make(handle: (req: any) => Promise<any> | any, options = {}) {
	const handler = {
		context: { prefix: new URL(PREFIX) },
		handleFetch: vi.fn(async (req: any) => handle(req)),
	} as any;
	return {
		handler,
		prefetcher: new Prefetcher(handler, { enabled: true, ...options }),
	};
}

const hint = (
	url: string,
	destination: any = "image",
	mode: any = "no-cors",
): PrefetchHint => ({ url, destination, mode });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Prefetcher", () => {
	it("fetches hints through the handler as faithful sub-resource requests", async () => {
		const { handler, prefetcher } = make(() => ok());
		prefetcher.schedule(source(), [
			hint(u("a.css"), "style"),
			hint(u("b.png")),
		]);
		await tick();
		const calls = handler.handleFetch.mock.calls.map((c: any) => c[0]);
		const css = calls.find((r: any) => r.rawDestination === "style");
		expect(css.method).toBe("GET");
		expect(css.prefetch).toBe(true);
		expect(css.referrer).toBe(u("page.html"));

		expect(css.rawClientUrl.href).toBe(u("page.html"));
		expect(css.clientId).toBe("client-1");
		expect(css.initialHeaders.get("accept")).toBe("text/css,*/*;q=0.1");
		expect(css.initialHeaders.get("user-agent")).toBe("UA");
		expect(css.initialHeaders.has("sec-fetch-dest")).toBe(false);
		expect(css.initialHeaders.has("upgrade-insecure-requests")).toBe(false);
	});

	it("uses the page as the client for resources found in a stylesheet", async () => {
		const { handler, prefetcher } = make(() => ok());
		const cssSource = source({
			rawUrl: new URL(u("a.css")),
			rawDestination: "style",
			rawClientUrl: new URL(u("page.html")),
		});
		prefetcher.schedule(cssSource, [hint(u("bg.png"))]);
		await tick();
		const req = handler.handleFetch.mock.calls[0][0];
		expect(req.referrer).toBe(u("a.css"));
		expect(req.rawClientUrl.href).toBe(u("page.html"));
	});

	it("serves a finished prefetch once and then falls through", async () => {
		const { prefetcher } = make(() => ok("PNG"));
		prefetcher.schedule(source(), [hint(u("b.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("b.png"));
		const first = await prefetcher.take(request, parsed);
		expect(first?.body).toBe("PNG");
		expect(prefetcher.take(request, parsed)).toBeNull();
		expect(prefetcher.stats.hits).toBe(1);
	});

	it("allows one take per reference found in the document", async () => {
		const { handler, prefetcher } = make(() => ok());
		prefetcher.schedule(source(), [hint(u("i.png")), hint(u("i.png"))]);
		await tick();
		expect(handler.handleFetch).toHaveBeenCalledTimes(1);
		const { request, parsed } = realRequest(u("i.png"));
		expect(await prefetcher.take(request, parsed)).not.toBeNull();
		expect(await prefetcher.take(request, parsed)).not.toBeNull();
		expect(prefetcher.take(request, parsed)).toBeNull();
	});

	it("lets a request join a prefetch that is still in flight", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { handler, prefetcher } = make(async () => {
			await gate;
			return ok("late");
		});
		prefetcher.schedule(source(), [hint(u("slow.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("slow.png"));
		const pending = prefetcher.take(request, parsed)!;
		release();
		expect((await pending)?.body).toBe("late");
		expect(handler.handleFetch).toHaveBeenCalledTimes(1);
		expect(prefetcher.stats.joined).toBe(1);
	});

	it("does not serve a different destination, mode, method or range request", async () => {
		const { prefetcher } = make(() => ok());
		prefetcher.schedule(source(), [hint(u("x.png"), "image", "no-cors")]);
		await tick();
		const wrongDest = realRequest(u("x.png"), "script");
		const wrongMode = realRequest(u("x.png"), "image", "cors");
		const post = realRequest(u("x.png"), "image", "no-cors", {
			method: "POST",
		});
		const range = realRequest(u("x.png"));
		range.request.initialHeaders.set("Range", "bytes=0-9");
		for (const r of [wrongDest, wrongMode, post, range]) {
			expect(prefetcher.take(r.request, r.parsed)).toBeNull();
		}

		const right = realRequest(u("x.png"));
		expect(await prefetcher.take(right.request, right.parsed)).not.toBeNull();
	});

	it("falls through when the prefetch failed", async () => {
		const { prefetcher } = make(() => {
			throw new Error("network down");
		});
		prefetcher.schedule(source(), [hint(u("f.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("f.png"));
		expect(prefetcher.take(request, parsed)).toBeNull();
		expect(prefetcher.stats.failed).toBe(1);
	});

	it("ignores data/blob URLs, foreign prefixes and strips fragments", async () => {
		const { handler, prefetcher } = make(() => ok());
		prefetcher.schedule(source(), [
			hint(PREFIX + "data:text/plain,hi"),
			hint(PREFIX + "blob:http://x/1"),
			hint("http://elsewhere.test/x.png"),
			hint(u("frag.png") + "#section"),
		]);
		await tick();
		expect(handler.handleFetch).toHaveBeenCalledTimes(1);
		expect(handler.handleFetch.mock.calls[0][0].rawUrl.href).toBe(
			u("frag.png"),
		);
	});

	it("limits concurrency and starts stylesheets before images", async () => {
		const started: string[] = [];
		const gates: (() => void)[] = [];
		const { prefetcher } = make(
			(req) =>
				new Promise((resolve) => {
					started.push(req.rawDestination);
					gates.push(() => resolve(ok()));
				}),
			{ maxConcurrent: 2 },
		);
		prefetcher.schedule(source(), [
			hint(u("1.png")),
			hint(u("2.png")),
			hint(u("s.css"), "style"),
			hint(u("f.woff"), "font", "cors"),
		]);
		await tick();
		expect(started).toEqual(["style", "font"]);
		gates.shift()!();
		await tick();
		expect(started.length).toBe(3);
		expect(started[2]).toBe("image");
	});

	it("drops responses larger than the per-entry limit", async () => {
		const { prefetcher } = make(() => ok(new ArrayBuffer(2048)), {
			maxEntryBytes: 1024,
		});
		prefetcher.schedule(source(), [hint(u("big.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("big.png"));
		expect(prefetcher.take(request, parsed)).toBeNull();
	});

	it("buffers stream bodies and hands out independent copies", async () => {
		const stream = () =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1, 2]));
					c.enqueue(new Uint8Array([3]));
					c.close();
				},
			});
		const { prefetcher } = make(() => ok(stream()));
		prefetcher.schedule(source(), [hint(u("s.png")), hint(u("s.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("s.png"));
		const a = (await prefetcher.take(request, parsed))!.body as ArrayBuffer;
		const b = (await prefetcher.take(request, parsed))!.body as ArrayBuffer;
		expect([...new Uint8Array(a)]).toEqual([1, 2, 3]);
		expect(a).not.toBe(b);
	});

	it("does nothing when disabled and for non-GET sources", async () => {
		const off = make(() => ok(), { enabled: false });
		off.prefetcher.schedule(source(), [hint(u("a.png"))]);
		const post = make(() => ok());
		post.prefetcher.schedule(source({ method: "POST" }), [hint(u("a.png"))]);
		await tick();
		expect(off.handler.handleFetch).not.toHaveBeenCalled();
		expect(post.handler.handleFetch).not.toHaveBeenCalled();
	});

	it("never serves a prefetch to another prefetch", async () => {
		const { prefetcher } = make(() => ok());
		prefetcher.schedule(source(), [hint(u("a.png"))]);
		await tick();
		const { request, parsed } = realRequest(u("a.png"), "image", "no-cors", {
			prefetch: true,
		});
		expect(prefetcher.take(request, parsed)).toBeNull();
	});

	it("expires unclaimed entries", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const { prefetcher } = make(() => ok(), { ttlMs: 1000 });
			prefetcher.schedule(source(), [hint(u("old.png"))]);
			await vi.advanceTimersByTimeAsync(10);
			vi.setSystemTime(5000);

			prefetcher.schedule(source(), [hint(u("new.png"))]);
			const { request, parsed } = realRequest(u("old.png"));
			expect(prefetcher.take(request, parsed)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Prefetcher safeguards", () => {
	it("skips URLs the browser will serve from its own cache", async () => {
		const { handler, prefetcher } = make(() => ok());
		const headers = new RamjetHeaders();
		headers.set("Cache-Control", "public, max-age=600");
		prefetcher.observe(u("cached.png"), headers);
		prefetcher.schedule(source(), [
			hint(u("cached.png")),
			hint(u("fresh.png")),
		]);
		await tick();
		expect(handler.handleFetch).toHaveBeenCalledTimes(1);
		expect(handler.handleFetch.mock.calls[0][0].rawUrl.href).toBe(
			u("fresh.png"),
		);
	});

	it("does not treat no-store or no-cache responses as browser-cached", async () => {
		const { handler, prefetcher } = make(() => ok());
		for (const value of ["no-store", "no-cache, max-age=600", "max-age=0"]) {
			const headers = new RamjetHeaders();
			headers.set("Cache-Control", value);
			prefetcher.observe(u("x.png"), headers);
		}
		prefetcher.schedule(source(), [hint(u("x.png"))]);
		await tick();
		expect(handler.handleFetch).toHaveBeenCalledTimes(1);
	});

	it("caps images and fonts taken from one source but never stylesheets or scripts", async () => {
		const { handler, prefetcher } = make(() => ok(), {
			maxImagesPerSource: 2,
			maxFontsPerSource: 1,
			maxConcurrent: 100,
			maxConcurrentWhenBusy: 100,
		});
		prefetcher.schedule(source(), [
			hint(u("1.png")),
			hint(u("2.png")),
			hint(u("3.png")),
			hint(u("a.woff"), "font", "cors"),
			hint(u("b.woff"), "font", "cors"),
			hint(u("a.css"), "style"),
			hint(u("a.js"), "script"),
		]);
		await tick();
		const dests = handler.handleFetch.mock.calls
			.map((c: any) => c[0].rawDestination)
			.sort();
		expect(dests).toEqual(["font", "image", "image", "script", "style"]);
	});

	it("backs off while real requests are in flight and resumes afterwards", async () => {
		const started: string[] = [];
		const gates: (() => void)[] = [];
		const { prefetcher } = make(
			(req) =>
				new Promise((resolve) => {
					started.push(req.rawUrl.href);
					gates.push(() => resolve(ok()));
				}),
			{ maxConcurrent: 3, maxConcurrentWhenBusy: 1 },
		);
		prefetcher.beginReal();
		prefetcher.schedule(source(), [
			hint(u("1.png")),
			hint(u("2.png")),
			hint(u("3.png")),
		]);
		await tick();
		expect(started.length).toBe(1);
		prefetcher.endReal();
		await tick();
		expect(started.length).toBe(3);
		gates.forEach((g) => g());
	});

	it("forgets queued prefetches when a new page is navigated to", async () => {
		const started: string[] = [];
		const gates: (() => void)[] = [];
		const { prefetcher } = make(
			(req) =>
				new Promise((resolve) => {
					started.push(req.rawUrl.href);
					gates.push(() => resolve(ok()));
				}),
			{ maxConcurrent: 1, maxConcurrentWhenBusy: 1 },
		);
		prefetcher.schedule(source(), [hint(u("run.png")), hint(u("queued.png"))]);
		await tick();
		prefetcher.cancelQueued();
		gates.forEach((g) => g());
		await tick();
		expect(started).toEqual([u("run.png")]);
		const { request, parsed } = realRequest(u("queued.png"));
		expect(prefetcher.take(request, parsed)).toBeNull();
	});
});

describe("Prefetcher defaults", () => {
	it("is disabled unless explicitly enabled", async () => {
		const handler = {
			context: { prefix: new URL(PREFIX) },
			handleFetch: vi.fn(async () => ok()),
		} as any;
		const prefetcher = new Prefetcher(handler);
		prefetcher.schedule(source(), [hint(u("a.png"))]);
		await tick();
		expect(handler.handleFetch).not.toHaveBeenCalled();
	});
});

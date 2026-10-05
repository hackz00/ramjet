import { describe, expect, it } from "vitest";
import {
	collectPrefetchHints,
	noteHtmlResource,
	type PrefetchHint,
} from "@rewriters/hints";
import { rewriteCss } from "@rewriters/css";

function collectHtml(
	tag: string,
	attr: string,
	attrs: Record<string, string | undefined>
): PrefetchHint[] {
	const hints: PrefetchHint[] = [];
	collectPrefetchHints(hints, () =>
		noteHtmlResource(tag, attr, "http://p/~/sj/x", attrs)
	);
	return hints;
}

describe("noteHtmlResource", () => {
	it("notes stylesheets, scripts and images with the right destination and mode", () => {
		expect(collectHtml("link", "href", { rel: "stylesheet" })).toEqual([
			{ url: "http://p/~/sj/x", destination: "style", mode: "no-cors" },
		]);
		expect(collectHtml("script", "src", {})[0]).toMatchObject({
			destination: "script",
			mode: "no-cors",
		});
		expect(collectHtml("script", "src", { type: "module" })[0]).toMatchObject({
			destination: "script",
			mode: "cors",
		});
		expect(collectHtml("img", "src", {})[0]).toMatchObject({
			destination: "image",
			mode: "no-cors",
		});
	});

	it("uses cors mode when crossorigin is present and for fonts", () => {
		expect(collectHtml("script", "src", { crossorigin: "" })[0].mode).toBe("cors");
		expect(
			collectHtml("link", "href", { rel: "stylesheet", crossorigin: "anonymous" })[0].mode
		).toBe("cors");
		expect(collectHtml("link", "href", { rel: "preload", as: "font" })[0]).toMatchObject({
			destination: "font",
			mode: "cors",
		});
	});

	it("skips lazy images, print stylesheets, unknown preloads, icons and anchors", () => {
		expect(collectHtml("img", "src", { loading: "lazy" })).toEqual([]);
		expect(
			collectHtml("link", "href", { rel: "stylesheet", media: "print" })
		).toEqual([]);
		expect(collectHtml("link", "href", { rel: "preload", as: "fetch" })).toEqual([]);
		expect(collectHtml("link", "href", { rel: "icon" })).toEqual([]);
		expect(collectHtml("a", "href", {})).toEqual([]);
	});

	it("notes nothing when no collector is active", () => {
		expect(() => noteHtmlResource("img", "src", "x", {})).not.toThrow();
	});
});

describe("rewriteCss hints", () => {
	const context = {
		prefix: new URL("http://p/~/sj/"),
		config: { flags: {}, siteFlags: {}, globals: {} },
		interface: {
			codecEncode: (s: string) => encodeURIComponent(s),
			codecDecode: (s: string) => decodeURIComponent(s),
		},
	} as any;
	const meta = {
		origin: new URL("http://site.test/"),
		base: new URL("http://site.test/a/s.css"),
	} as any;
	const find = (hints: PrefetchHint[], needle: string) =>
		hints.find((h) => decodeURIComponent(h.url).includes(needle));

	it("classifies @import, @font-face sources and backgrounds", () => {
		const css = `@import url("imp.css");@import "imp2.css";@font-face{font-family:F;src:url(f.woff2) format('woff2')}.a{background:url(bg.png)}`;
		const hints: PrefetchHint[] = [];
		collectPrefetchHints(hints, () => rewriteCss(css, context, meta));
		expect(find(hints, "imp.css")).toMatchObject({ destination: "style", mode: "no-cors" });
		expect(find(hints, "imp2.css")).toMatchObject({ destination: "style" });
		expect(find(hints, "f.woff2")).toMatchObject({ destination: "font", mode: "cors" });
		expect(find(hints, "bg.png")).toMatchObject({ destination: "image", mode: "no-cors" });
	});

	it("does not mistake a url() after a closed @font-face block for a font", () => {
		const css = `@font-face{font-family:F;src:url(f.woff2)}.b{background:url(after.png)}`;
		const hints: PrefetchHint[] = [];
		collectPrefetchHints(hints, () => rewriteCss(css, context, meta));
		expect(find(hints, "after.png")).toMatchObject({ destination: "image" });
	});

	it("leaves the rewritten output unchanged by collection", () => {
		const css = `.a{background:url(bg.png)}@import "x.css";`;
		const plain = rewriteCss(css, context, meta);
		const hints: PrefetchHint[] = [];
		expect(collectPrefetchHints(hints, () => rewriteCss(css, context, meta))).toBe(plain);
	});
});

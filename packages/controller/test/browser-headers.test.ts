import { describe, expect, it } from "vitest";
import { acceptLanguage, browserHeaders, clientHints } from "../src/browser-headers";

const chrome = {
	languages: ["en-US", "en", "de"],
	userAgentData: {
		brands: [
			{ brand: "Chromium", version: "154" },
			{ brand: "Not/A)Brand", version: "24" },
		],
		mobile: false,
		platform: "Windows",
	},
};

describe("acceptLanguage", () => {
	it("weights the preference list like Chrome", () => {
		expect(acceptLanguage(["en-US", "en"])).toBe("en-US,en;q=0.9");
		expect(acceptLanguage(["en-US", "en", "de"])).toBe("en-US,en;q=0.9,de;q=0.8");
		expect(acceptLanguage(["fr"])).toBe("fr");
	});

	it("is null when the browser reports nothing, and caps the list", () => {
		expect(acceptLanguage([])).toBeNull();
		expect(acceptLanguage(undefined)).toBeNull();
		expect(acceptLanguage(["a", "b", "c", "d", "e", "f", "g"])?.split(",")).toHaveLength(5);
	});
});

describe("clientHints", () => {
	it("builds the low-entropy hints from userAgentData", () => {
		expect(clientHints(chrome.userAgentData)).toEqual({
			"sec-ch-ua": '"Chromium";v="154", "Not/A)Brand";v="24"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Windows"',
		});
		expect(clientHints({ ...chrome.userAgentData, mobile: true })?.["sec-ch-ua-mobile"]).toBe("?1");
	});

	it("is null for browsers without userAgentData and escapes quotes in brand names", () => {
		expect(clientHints(undefined)).toBeNull();
		expect(clientHints({ brands: [] })).toBeNull();
		expect(clientHints({ brands: [{ brand: 'a"b', version: "1" }] })?.["sec-ch-ua"]).toBe('"a\\"b";v="1"');
	});
});

describe("browserHeaders", () => {
	it("adds language and client hints for https targets", () => {
		const names = browserHeaders(new URL("https://site.test/"), chrome).map(([k]) => k);
		expect(names).toEqual(["accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
	});

	it("sends no client hints to insecure origins, as Chrome does, but still the language", () => {
		const names = browserHeaders(new URL("http://site.test/"), chrome).map(([k]) => k);
		expect(names).toEqual(["accept-language"]);
	});

	it("falls back to navigator.language, and adds nothing without a navigator", () => {
		expect(browserHeaders(new URL("https://x.test/"), { language: "pt-BR" })).toEqual([["accept-language", "pt-BR"]]);
		expect(browserHeaders(new URL("https://x.test/"), undefined)).toEqual([]);
	});
});

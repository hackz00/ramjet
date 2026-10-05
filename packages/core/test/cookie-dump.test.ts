import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/shared/cookie";

const url = (u: string) => new URL(u);

function jar() {
	const j = new CookieJar();
	j.setCookies("host=1; Path=/", url("https://a.example.com/x/y"));
	j.setCookies(
		"shared=2; Domain=example.com; Path=/",
		url("https://a.example.com/x/y"),
	);
	j.setCookies("deep=3; Path=/private", url("https://a.example.com/x/y"));
	j.setCookies("secret=4; Path=/; HttpOnly", url("https://a.example.com/"));
	j.setCookies("other=5; Path=/", url("https://other.org/"));
	j.setCookies("sibling=6; Path=/", url("https://b.example.com/"));
	j.setCookies("gone=7; Path=/; Max-Age=60", url("https://a.example.com/"));
	return j;
}

const names = (dumped: string) =>
	Object.values(JSON.parse(dumped) as Record<string, { name: string }>)
		.map((c) => c.name)
		.sort();

describe("CookieJar.dumpFor", () => {
	it("contains only cookies that can apply to the document's host", () => {
		const j = jar();
		expect(names(j.dumpFor(url("https://a.example.com/x/y")))).toEqual([
			"deep",
			"gone",
			"host",
			"secret",
			"shared",
		]);

		expect(names(j.dumpFor(url("https://b.example.com/")))).toEqual([
			"shared",
			"sibling",
		]);
		expect(names(j.dumpFor(url("https://other.org/")))).toEqual(["other"]);
		expect(names(j.dumpFor(url("https://unrelated.net/")))).toEqual([]);
	});

	it("never includes another site's cookies, and a host-only cookie does not leak to subdomains", () => {
		const j = new CookieJar();
		j.setCookies("hostonly=1; Path=/", url("https://example.com/"));
		expect(names(j.dumpFor(url("https://www.example.com/")))).toEqual([]);
		expect(names(j.dumpFor(url("https://example.com/")))).toEqual(["hostonly"]);
		expect(names(j.dumpFor(url("https://notexample.com/")))).toEqual([]);
	});

	it("drops cookies that have already expired", () => {
		const j = new CookieJar();
		j.setCookies(
			"old=1; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
			url("https://example.com/"),
		);
		j.setCookies("new=2; Path=/", url("https://example.com/"));
		expect(names(j.dumpFor(url("https://example.com/")))).toEqual(["new"]);
	});

	it("loads back into a jar that answers like the original for that host", () => {
		const source = jar();
		for (const target of [
			"https://a.example.com/x/y",
			"https://a.example.com/private/z",
			"https://b.example.com/",
			"https://other.org/q",
		]) {
			const copy = new CookieJar();
			copy.load(source.dumpFor(url(target)));
			for (const fromJs of [true, false]) {
				expect(
					copy.getCookies(url(target), fromJs),
					`${target} fromJs=${fromJs}`,
				).toBe(source.getCookies(url(target), fromJs));
			}
		}
	});

	it("is much smaller than a full dump when the jar holds many sites", () => {
		const j = new CookieJar();
		for (let i = 0; i < 300; i++)
			j.setCookies(
				`c${i}=${"v".repeat(40)}; Path=/`,
				url(`https://site${i}.test/`),
			);
		j.setCookies("mine=1; Path=/", url("https://mine.test/"));
		expect(j.dumpFor(url("https://mine.test/")).length).toBeLessThan(
			j.dump().length / 50,
		);
	});
});

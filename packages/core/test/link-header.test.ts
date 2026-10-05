import { describe, expect, it } from "vitest";
import { rewriteLinkHeader } from "../src/fetch/headers";
import { context, newMeta } from "./html-fixtures";

describe("rewritten Link preloads", () => {
	it("removes integrity from multiple preloads and preserves other parameters", () => {
		const result = rewriteLinkHeader('<https://cdn.example/a.css>; rel=preload; as=style; crossorigin; integrity="sha384-old", </app.js>; INTEGRITY=sha256-old; rel=preload; as=script', context, newMeta());
		expect(result).not.toMatch(/;\s*integrity=/i);
		expect(result).toContain("rel=preload; as=style; crossorigin");
		expect(result).toContain("rel=preload; as=script");
		expect(result).not.toContain("<https://cdn.example/a.css>");
	});
	it("leaves integrity-like text in quoted parameters intact", () => {
		const result = rewriteLinkHeader('</a.css>; title="a; integrity=keep, \\"quoted\\""; integrity="sha384-old"; rel=preload', context, newMeta());
		expect(result).toContain('title="a; integrity=keep, \\"quoted\\""');
		expect(result).not.toContain('integrity="sha384-old"');
	});
});

import { describe, expect, it } from "vitest";
import { rewriteUrl } from "@rewriters/url";

function make() {
  let encodes = 0;
  const context = {
    prefix: new URL("http://localhost:4500/~/sj/"),
    config: { flags: {}, siteFlags: {}, globals: {} },
    interface: {
      codecEncode: (s: string) => {
        encodes++;
        return encodeURIComponent(s);
      },
      codecDecode: (s: string) => decodeURIComponent(s),
    },
  } as any;
  const meta = (base: string, origin = "https://example.com/") =>
    ({ origin: new URL(origin), base: new URL(base) }) as any;
  return { context, meta, encodes: () => encodes };
}

describe("rewriteUrl memo", () => {
  it("returns the same result without re-encoding on a repeat call", () => {
    const { context, meta, encodes } = make();
    const m = meta("https://example.com/a/b.html");
    const first = rewriteUrl("../img/x.png?q=1#frag", context, m);
    const afterFirst = encodes();
    const second = rewriteUrl("../img/x.png?q=1#frag", context, m);
    expect(second).toBe(first);
    expect(encodes()).toBe(afterFirst);
  });

  it("keys on base and origin", () => {
    const { context, meta } = make();
    const a = rewriteUrl("x.png", context, meta("https://example.com/a/"));
    const b = rewriteUrl("x.png", context, meta("https://example.com/b/"));
    expect(a).not.toBe(b);
    const c = rewriteUrl(
      "x.png",
      context,
      meta("https://example.com/a/", "https://other.org/"),
    );
    expect(c).not.toBe(a);
  });

  it("matches the uncached path (explicit options bypass the memo)", () => {
    const { context, meta } = make();
    const m = meta("https://example.com/dir/page.html");
    for (const u of [
      "/abs",
      "rel/p?x=1",
      "//cdn.example.org/lib.js",
      "https://a.b/c#h",
      "mailto:a@b.c",
      "chrome://x",
      "http://[bad",
    ]) {
      expect(rewriteUrl(u, context, m)).toBe(rewriteUrl(u, context, m, {}));
    }
  });

  it("passes unparseable and custom-scheme URLs through unchanged", () => {
    const { context, meta } = make();
    const m = meta("https://example.com/");
    expect(rewriteUrl("chrome://settings", context, m)).toBe(
      "chrome://settings",
    );
    expect(rewriteUrl("mailto:a@b.c", context, m)).toBe("mailto:a@b.c");
  });
});

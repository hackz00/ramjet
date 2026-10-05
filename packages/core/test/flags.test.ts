import { describe, expect, it } from "vitest";
import { flagEnabled, resolveFlags } from "@/shared";

const flags = { a: false, b: true, c: false, d: true } as any;

function ctx(siteFlags: Record<string, any>) {
  return { config: { flags, siteFlags } } as any;
}

describe("resolveFlags", () => {
  it("returns the base flags when there are no site flags", () => {
    expect(resolveFlags(ctx({}), new URL("https://x.com/"))).toEqual(flags);
  });

  it("matches flagEnabled for every flag, first matching pattern wins", () => {
    const c = ctx({
      "example\.com": { a: true, b: false },
      example: { a: false, c: true },
      "^https://other\.org": { d: false },
    });
    for (const href of [
      "https://example.com/p",
      "https://example.net/",
      "https://other.org/x",
      "https://none.io/",
    ]) {
      const url = new URL(href);
      const resolved = resolveFlags(c, url);
      for (const flag of Object.keys(flags)) {
        expect(resolved[flag], `${href} ${flag}`).toBe(
          flagEnabled(flag as any, c, url),
        );
      }
    }
  });

  it("does not mutate the config", () => {
    const c = ctx({ x: { a: true } });
    resolveFlags(c, new URL("https://x.com/"));
    expect(flags.a).toBe(false);
  });
});

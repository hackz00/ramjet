import { describe, expect, it, vi } from "vitest";
import hookXHR from "../src/client/shared/requests/xmlhttprequest";
import type { RamjetClient } from "../src/client";

describe("synchronous XHR flag", () => {
	it("uses the current flag API and ignores disabled synchronous requests", () => {
		const handlers = new Map<string, { apply: (context: unknown) => void }>();
		const flagEnabled = vi.fn(() => false);
		const client = {
			Proxy: (name: string, handler: { apply: (context: unknown) => void }) =>
				handlers.set(name, handler),
			Trap: vi.fn(),
			flagEnabled,
			rewriteUrl: (url: string) => url,
		} as unknown as RamjetClient;
		hookXHR(client, globalThis as unknown as Self);
		const xhr = {};
		handlers
			.get("XMLHttpRequest.prototype.open")!
			.apply({ this: xhr, args: ["GET", "https://example.com/", false] });
		const returnValue = vi.fn();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() =>
				handlers
					.get("XMLHttpRequest.prototype.send")!
					.apply({ this: xhr, args: [], return: returnValue }),
			).not.toThrow();
			expect(flagEnabled).toHaveBeenCalledWith("syncxhr");
			expect(returnValue).toHaveBeenCalledWith(undefined);
		} finally {
			warning.mockRestore();
		}
	});
});

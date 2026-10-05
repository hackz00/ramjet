import { describe, expect, it, vi } from "vitest";
import install from "../src/client/dom/view-transition";

function setup(host = "www.youtube.com", ua = "Chrome/154.0.8037.95") {
	const proxy = vi.fn();
	install({ url: new URL(`https://${host}/watch`), Proxy: proxy } as any, {
		navigator: { userAgent: ua },
		Document: { prototype: { startViewTransition() {} } },
	} as any);
	return proxy;
}

describe("YouTube Chrome 154 view-transition crash compatibility", () => {
	it.each(["youtube.com", "www.youtube.com", "m.youtube.com"])(
		"installs on %s", host => expect(setup(host)).toHaveBeenCalledOnce()
	);
	it.each(["example.com", "notyoutube.com", "youtube.com.example.org"])(
		"leaves %s alone", host => expect(setup(host)).not.toHaveBeenCalled()
	);
	it.each(["Chrome/153.0", "Chrome/155.0", "Firefox/154.0"])(
		"leaves unverified browser versions alone: %s", ua =>
			expect(setup("www.youtube.com", ua)).not.toHaveBeenCalled()
	);
	it("returns the native transition and skips only its animation", () => {
		const proxy = setup();
		const transition = { skipTransition: vi.fn(), updateCallbackDone: Promise.resolve() };
		const call = vi.fn(() => transition);
		const returnValue = vi.fn();
		proxy.mock.calls[0][1].apply({ call, return: returnValue });
		expect(call).toHaveBeenCalledOnce();
		expect(transition.skipTransition).toHaveBeenCalledOnce();
		expect(returnValue).toHaveBeenCalledWith(transition);
	});
	it("preserves native argument-validation errors", () => {
		const proxy = setup();
		const error = new TypeError("Invalid update callback");
		expect(() => proxy.mock.calls[0][1].apply({ call() { throw error; } })).toThrow(error);
	});
});

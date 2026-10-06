import { describe, expect, it, vi } from "vitest";
vi.mock("@client/entry", () => ({ iswindow: false }));
import hookMessages from "../src/client/shared/postmessage";
import { RAMJETCLIENT } from "../src/symbols";
import type { RamjetClient } from "../src/client";

function setup(url: string, parent?: ReturnType<typeof setup>) {
	const hooks = new Map<string, any>();
	const self = { DOMException };
	const client = {
		url: new URL(url),
		global: { parent: parent ? { [RAMJETCLIENT]: parent.client } : undefined },
		config: { globals: { wrappostmessagefn: "wrap" } },
		Proxy(names: string | string[], hook: unknown) {
			for (const name of typeof names === "string" ? [names] : names)
				hooks.set(name, hook);
		},
		Trap(name: string, hook: unknown) {
			hooks.set(name, hook);
		},
	} as unknown as RamjetClient;
	hookMessages(client, self as unknown as Self);
	function create(...input: unknown[]) {
		const args = [...input];
		let returned: { nativeName: string };
		const call = () => {
			if (!args.length) throw new TypeError("name required");
			return { nativeName: String(args[0]) };
		};
		hooks.get("BroadcastChannel").construct({
			args,
			call,
			return: (v: typeof returned) => (returned = v),
		});
		return returned!;
	}
	return { client, hooks, create };
}

describe("BroadcastChannel origins", () => {
	it("same-origin pages share a native name, different origins do not", () => {
		const a = setup("https://a.example/page").create("updates");
		const same = setup("https://a.example/other").create("updates");
		const different = setup("https://b.example/page").create("updates");
		expect(a.nativeName).toBe(same.nativeName);
		expect(a.nativeName).not.toBe(different.nativeName);
		expect(a.nativeName).not.toBe("updates");
	});

	it("preserves the public name and payload, with native getter checks", () => {
		const { create, hooks } = setup("https://a.example/");
		const channel = create("name@with:/separators");
		const getter = hooks.get("BroadcastChannel.prototype.name").get;
		expect(getter({ this: channel, get: () => channel.nativeName })).toBe(
			"name@with:/separators",
		);
		expect(() =>
			getter({
				this: {},
				get: () => {
					throw new TypeError("illegal receiver");
				},
			}),
		).toThrow(TypeError);
		const payload = { text: "hello" };
		const args = [payload];
		hooks
			.get("BroadcastChannel.prototype.postMessage")
			.apply({ this: channel, args });
		expect(args[0]).toEqual({
			$ramjet$messagetype: "window",
			$ramjet$origin: "https://a.example",
			$ramjet$data: payload,
		});
	});

	it("inherits blank/srcdoc origins and separates opaque contexts", () => {
		const parent = setup("https://a.example/");
		const blank = setup("about:blank", parent);
		const srcdoc = setup("about:srcdoc", blank);
		expect(srcdoc.create("updates").nativeName).toBe(
			parent.create("updates").nativeName,
		);
		for (const url of ["about:blank", "data:text/html,test"])
			expect(() => setup(url).create("updates")).toThrow(
				expect.objectContaining({ name: "SecurityError" }),
			);
	});

	it("preserves argument conversion and required-name errors", () => {
		const { create } = setup("https://a.example/");
		expect(() => create()).toThrow(TypeError);
		expect(() => create(Symbol("name"))).toThrow(TypeError);
		expect(create(undefined).nativeName).toContain('"undefined"');
		expect(create({ toString: () => "object-name" }).nativeName).toContain(
			'"object-name"',
		);
	});
});

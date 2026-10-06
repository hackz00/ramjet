import { iswindow } from "@client/entry";
import { RAMJETCLIENT } from "@/symbols";
import { RamjetClient } from "@client/index";
import { Object_defineProperty, JSON_stringify, JSON_parse, _WeakMap } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

export default function (client: RamjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0];
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2];
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT];
				} else {
					pollutant = {};
				}

				const {
					constructor: { constructor: Function },
				} = pollutant;

				const callerGlobalThisProxied: Self = Function("return globalThis")();
				const callerClient = callerGlobalThisProxied[RAMJETCLIENT];

				const wrappedPostMessage = Function("...args", "this(...args)");

				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				ctx.args[0] = {
					$ramjet$messagetype: "window",
					$ramjet$origin: inherit
						? callerClient.global.parent[RAMJETCLIENT].url.origin
						: callerClient.url.origin,
					$ramjet$data: ctx.args[0],
				};

				if (typeof ctx.args[1] === "string") ctx.args[1] = "*";
				if (typeof ctx.args[1] === "object") ctx.args[1].targetOrigin = "*";

				ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
			},
		});

	const channels = new _WeakMap<
		BroadcastChannel,
		{ name: string; origin: string }
	>([]);
	client.Proxy("BroadcastChannel", {
		construct(ctx) {
			if ((ctx.args as unknown[]).length === 0) return ctx.return(ctx.call());
			const name = `${ctx.args[0]}`;
			let owner = client;
			while (
				owner.url.href === "about:blank" ||
				owner.url.href === "about:srcdoc"
			) {
				const parent = owner.global.parent?.[RAMJETCLIENT];
				if (!parent || parent === owner) break;
				owner = parent;
			}
			const origin = owner.url.origin;
			if (origin === "null")
				throw new self.DOMException(
					"Opaque origin cannot open a channel",
					"SecurityError",
				);
			ctx.args[0] = JSON_stringify(["ramjet-channel-v1", origin, name]);
			const channel = ctx.call();
			channels.set(channel, { name, origin });
			ctx.return(channel);
		},
	});
	client.Trap("BroadcastChannel.prototype.name", {
		get(ctx) {
			const nativeName = ctx.get();
			const own = channels.get(ctx.this);
			if (own) return own.name;
			try {
				const parts = JSON_parse(nativeName);
				if (parts?.[0] === "ramjet-channel-v1" && typeof parts[2] === "string")
					return parts[2];
			} catch {}
			return nativeName;
		},
	});
	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$ramjet$messagetype: "window",

				$ramjet$origin: channels.get(ctx.this)?.origin ?? client.url.origin,
				$ramjet$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage");

	client.Proxy(toproxy, {
		apply(ctx) {
			ctx.args[0] = {
				$ramjet$messagetype: "worker",
				$ramjet$data: ctx.args[0],
			};
		},
	});
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (!obj || typeof obj.postMessage !== "function") return obj;
			return {
				postMessage: obj.postMessage.bind(obj),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}

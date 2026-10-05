import { RamjetClient } from "@client/index";
import { RAMJETCLIENT } from "@/symbols";
import { String } from "@/shared/snapshot";

export default function (client: RamjetClient) {
	client.Proxy("window.open", {
		apply(ctx) {
			if (typeof ctx.args[0] !== "undefined") {
				const url = String(ctx.args[0]);

				if (url !== "") {
					ctx.args[0] = client.rewriteUrl(url);
				}
			}

			if (typeof ctx.args[1] !== "undefined" && ctx.args[1] !== null) {
				let target = String(ctx.args[1]);

				if (target === "_top" || target === "_unfencedTop") {
					target = client.meta.topFrameName;
				}
				if (target === "_parent") {
					target = client.meta.parentFrameName;
				}

				ctx.args[1] = target;
			}

			const realwin = ctx.call();

			if (!realwin) return ctx.return(realwin);

			if (!(RAMJETCLIENT in realwin)) {
				client.init.hookSubcontext(realwin);
			}

			return realwin;
		},
	});

	client.Trap("window.frameElement", {
		get(ctx) {
			const f = ctx.get() as HTMLIFrameElement | null;
			if (!f) return f;

			const win = f.ownerDocument.defaultView;
			if (win[RAMJETCLIENT]) {
				return f;
			} else {
				return null;
			}
		},
	});
}

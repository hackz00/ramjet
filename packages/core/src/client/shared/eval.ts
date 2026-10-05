import { rewriteJs } from "@rewriters/js";
import { RamjetClient } from "@client/index";
import { Object_defineProperty, String } from "@/shared/snapshot";

export default function (client: RamjetClient, self: Self) {
	Object_defineProperty(self, client.config.globals.rewritefn, {
		value: function (js: any) {
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			const rewritten = rewriteJs(
				js,
				"(direct eval proxy)",
				client.context,
				client.meta,
			);

			return rewritten;
		},
		writable: false,
		configurable: false,
	});
}

export function createIndirectEval(client: RamjetClient) {
	const indirection = client.global.eval;
	const proxy = new Proxy(client.global.eval, {
		apply(_target, _thisArg, args) {
			let js = args[0];

			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			return indirection(
				rewriteJs(
					js,
					"(indirect eval proxy)",
					client.context,
					client.meta,
				) as string,
			);
		},
	});
	client.box.unproxy.set(proxy, client.global.eval);

	return proxy;
}

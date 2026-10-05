import { RamjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { String, _URL } from "@/shared/snapshot";

export default function (client: RamjetClient, _self: Self) {
	client.Proxy(
		["History.prototype.pushState", "History.prototype.replaceState"],
		{
			apply(ctx) {
				const relevantclient = client.box.histories.get(ctx.this);
				const url = ctx.args[2] ? String(ctx.args[2]) : undefined;

				if (_URL.canParse(url)) {
					const parsedUrl = new _URL(url);
					if (parsedUrl.origin !== relevantclient.url.origin) {
						return ctx.return(undefined);
					}
				}

				if (url || url === "") ctx.args[2] = relevantclient.rewriteUrl(url);
				ctx.call();
				Tap.dispatch(
					relevantclient.hooks.lifecycle.navigate,
					{
						type: "history",
					},
					{
						url: relevantclient.url.href,
					},
				);
			},
		},
	);
}

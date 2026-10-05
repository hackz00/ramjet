import { RamjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: RamjetClient, _self: Self) {
	client.Proxy("Navigator.prototype.sendBeacon", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});
}

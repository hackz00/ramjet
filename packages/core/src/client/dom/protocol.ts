import { RamjetClient } from "@client/index";

export default function (client: RamjetClient) {
	client.Proxy("Navigator.prototype.registerProtocolHandler", {
		apply(ctx) {
			ctx.return();
		},
	});
	client.Proxy("Navigator.prototype.unregisterProtocolHandler", {
		apply(ctx) {
			ctx.return(undefined);
		},
	});
}

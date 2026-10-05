import { RamjetClient } from "@client/index";

export default function (client: RamjetClient) {
	client.Proxy("console.clear", {
		apply(ctx) {
			ctx.return(undefined);
		},
	});

	const log = console.log;
	client.Trap("console.log", {
		set(_ctx, _v) {},
		get(_ctx) {
			return log;
		},
	});
}

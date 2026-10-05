import { RamjetClient } from "@client/index";

export default function (client: RamjetClient, _self: GlobalThis) {
	client.Proxy("Worker", {
		construct(ctx) {
			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				destination: "worker",
				isModule: ctx.args[1]?.type === "module",
			});

			const worker = ctx.call();
		},
	});

	client.Proxy("SharedWorker", {
		construct(ctx) {
			const isModule =
				typeof ctx.args[1] === "object" && ctx.args[1]?.type === "module";

			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				destination: "sharedworker",
				isModule,
			});

			if (ctx.args[1] && typeof ctx.args[1] === "string")
				ctx.args[1] = `${client.url.origin}@${ctx.args[1]}`;

			if (ctx.args[1] && typeof ctx.args[1] === "object") {
				if (ctx.args[1].name) {
					ctx.args[1].name = `${client.url.origin}@${ctx.args[1].name}`;
				}
			}

			const worker = ctx.call();
		},
	});

	client.Proxy("Worklet.prototype.addModule", {
		apply(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
}

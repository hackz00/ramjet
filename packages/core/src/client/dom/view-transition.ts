import type { RamjetClient } from "@client/index";

export default function (client: RamjetClient, self: typeof window) {
	const host = client.url.hostname;
	if (
		!/(?:Chrome|Chromium)\/154\./.test(self.navigator.userAgent) ||
		!(host === "youtube.com" || host.endsWith(".youtube.com")) ||
		typeof self.Document.prototype.startViewTransition !== "function"
	)
		return;

	client.Proxy("Document.prototype.startViewTransition", {
		apply(ctx) {
			const transition = ctx.call();
			transition.skipTransition();
			ctx.return(transition);
		},
	});
}

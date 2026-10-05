import { RamjetHeaders } from "@ramjet/core";
import { ManagedPlugin } from "@ramjet/controller";
import type { Frame } from "@ramjet/controller";

export class CatchEscapedLinksPlugin extends ManagedPlugin {
	constructor(private toLocation: (url: URL) => string | URL) {
		super("catch-escaped-links", []);
	}

	install(frame: Frame): void {
		this.tap(
			frame.hooks.fetch.intercept,
			(context, props) => {
				if (context.parsed.destination !== "document") return;

				const location = this.toLocation(context.parsed.url);
				props.response = {
					body: "",
					status: 302,
					statusText: "Found",
					headers: RamjetHeaders.fromRawHeaders([
						["Location", String(location)],
					]),
				};
			},
			{ after: ["ramjet-http-cache"] },
		);
	}
}

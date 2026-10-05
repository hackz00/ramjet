import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	RamjetFetchHandler,
	RamjetFetchParsed,
	RamjetFetchRequest,
} from ".";
import {
	flagEnabled,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import { collectPrefetchHints, type PrefetchHint } from "@rewriters/hints";
import { createStreamingRewriter } from "@rewriters/html-stream";
import { streamHtmlResponse } from "./stream-html";
import { Tap } from "@/Tap";
import { _TextDecoder } from "@/shared/snapshot";

export async function rewriteBody(
	handler: RamjetFetchHandler,
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
	response: BareResponse,
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document":
			if (isHtmlMimeType(response.headers.get("content-type") ?? "")) {
				const htmlcontext = {
					loadScripts: true,
					inline: true,
					source: parsed.url.href,
					headers: response.rawHeaders,

					history: parsed.trackedClient!.history,
				};

				const streaming =
					handler.streamHtml &&
					response.body &&
					!Tap.hasListeners(handler.hooks.fetch.response)
						? createStreamingRewriter(handler.context, parsed.meta, htmlcontext)
						: null;
				if (streaming) {
					return streamHtmlResponse(
						response,
						streaming,
						request,
						handler.prefetcher,
					);
				}

				const buf = await response.arrayBuffer();
				const bytes = new Uint8Array(buf);
				const encoding = sniffEncoding(
					bytes,
					response.headers.get("content-type"),
				);
				const htmlContent = new _TextDecoder(encoding).decode(bytes);

				const hints: PrefetchHint[] = [];
				const html = collectPrefetchHints(hints, () =>
					rewriteHtml(htmlContent, handler.context, parsed.meta, {
						loadScripts: true,
						inline: true,
						source: parsed.url.href,
						headers: response.rawHeaders,

						history: parsed.trackedClient!.history,
					}),
				);
				handler.prefetcher.schedule(request, hints);
				return html;
			} else {
				return response.body;
			}
		case "script": {
			if (response.ok) {
				const ct = response.headers.get("content-type");

				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}

				let rewritten = rewriteJs(
					new Uint8Array(await response.arrayBuffer()),
					response.url,
					handler.context,
					parsed.meta,
					parsed.isModule,
				);

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (rewritten instanceof Uint8Array) {
						rewritten = new TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style": {
			const hints: PrefetchHint[] = [];
			const css = await response.text();
			const rewritten = collectPrefetchHints(hints, () =>
				rewriteCss(css, handler.context, parsed.meta),
			);
			handler.prefetcher.schedule(request, hints);
			return rewritten;
		}
		case "sharedworker":
		case "worker":
			return rewriteWorkers(
				new Uint8Array(await response.arrayBuffer()),
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule,
			);
		default:
			return response.body;
	}
}

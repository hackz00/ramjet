import type { BareResponse } from "@mercuryworkshop/proxy-transports";
import type { RamjetFetchRequest } from ".";
import type { StreamingHtmlRewriter } from "@rewriters/html-stream";
import { collectPrefetchHints, type PrefetchHint } from "@rewriters/hints";
import {
	extractCharsetFromContentType,
	sniffEncoding,
} from "@/shared/sniffEncoding";
import { _TextDecoder } from "@/shared/snapshot";
import type { Prefetcher } from "./prefetch";

const PRESCAN_BYTES = 1024;

const BOM_BYTES = 3;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export async function streamHtmlResponse(
	response: BareResponse,
	rewriter: StreamingHtmlRewriter,
	request: RamjetFetchRequest,
	prefetcher: Prefetcher,
): Promise<ReadableStream<Uint8Array>> {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();

	const contentType = response.headers.get("content-type");
	const needBytes = extractCharsetFromContentType(contentType ?? "")
		? BOM_BYTES
		: PRESCAN_BYTES;
	const head: Uint8Array[] = [];
	let headBytes = 0;
	let upstreamDone = false;
	while (headBytes < needBytes) {
		const { done, value } = await reader.read();
		if (done) {
			upstreamDone = true;
			break;
		}
		head.push(value);
		headBytes += value.byteLength;
	}
	const first = concat(head, headBytes);
	const decoder = new _TextDecoder(sniffEncoding(first, contentType));
	const encoder = new TextEncoder();

	const run = (fn: () => string): string => {
		const hints: PrefetchHint[] = [];
		const out = collectPrefetchHints(hints, fn);
		if (hints.length) prefetcher.schedule(request, hints);
		return out;
	};

	let pendingFirst: Uint8Array | null = first.byteLength ? first : null;
	let finished = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (!finished) {
					let text: string;
					if (pendingFirst) {
						const chunk = pendingFirst;
						pendingFirst = null;
						text = run(() =>
							rewriter.write(decoder.decode(chunk, { stream: true })),
						);
					} else if (upstreamDone) {
						finished = true;
						text = run(() => rewriter.write(decoder.decode()) + rewriter.end());
					} else {
						const { done, value } = await reader.read();
						if (done) {
							upstreamDone = true;
							continue;
						}
						text = run(() =>
							rewriter.write(decoder.decode(value, { stream: true })),
						);
					}
					if (text) {
						controller.enqueue(encoder.encode(text));
						if (!finished) return;
					}
				}
				controller.close();
			} catch (error) {
				controller.error(error);
				void reader.cancel(error).catch(() => {});
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

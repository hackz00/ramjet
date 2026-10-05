import type {
	RamjetFetchHandler,
	RamjetFetchParsed,
	RamjetFetchRequest,
	RamjetFetchResponse,
} from ".";
import { RamjetHeaders } from "@/shared/headers";
import type { PrefetchHint } from "@rewriters/hints";
import { _Map } from "@/shared/snapshot";

export type PrefetchOptions = {
	enabled: boolean;

	preconnect: boolean;

	maxConcurrent: number;

	maxConcurrentWhenBusy: number;

	maxImagesPerSource: number;
	maxFontsPerSource: number;

	maxEntries: number;

	maxBytes: number;

	maxEntryBytes: number;

	ttlMs: number;
};

export const DEFAULT_PREFETCH_OPTIONS: PrefetchOptions = {
	enabled: false,
	preconnect: false,
	maxConcurrent: 12,
	maxConcurrentWhenBusy: 4,
	maxImagesPerSource: 32,
	maxFontsPerSource: 6,
	maxEntries: 400,
	maxBytes: 96 * 1024 * 1024,
	maxEntryBytes: 8 * 1024 * 1024,
	ttlMs: 30_000,
};

type StoredBody = string | ArrayBuffer | null;
type Stored = {
	status: number;
	statusText: string;
	headers: RamjetHeaders;
	body: StoredBody;
	bytes: number;
};

type Entry = {
	key: string;
	refs: number;
	created: number;
	promise: Promise<Stored | null>;
	bytes: number;
};

type Job = {
	entry: Entry;
	request: RamjetFetchRequest;
	resolve: (s: Stored | null) => void;
};

const PRIORITY: Partial<Record<RequestDestination, number>> = {
	style: 0,
	script: 1,
	font: 2,
	image: 3,
};

const ACCEPT: Partial<Record<RequestDestination, string>> = {
	style: "text/css,*/*;q=0.1",
	script: "*/*",
	image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
	font: "*/*",
};

const STRIP_HEADERS = [
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"sec-fetch-user",
	"upgrade-insecure-requests",
	"purpose",
	"range",
	"if-none-match",
	"if-modified-since",
	"cache-control",
	"pragma",
	"origin",
	"priority",
	"content-type",
	"content-length",
];

function keyOf(url: string, destination: string, mode: string): string {
	return `${destination}\n${mode}\n${url}`;
}

export class Prefetcher {
	private readonly entries = new _Map<string, Entry>();
	private readonly queues: Job[][] = [[], [], [], [], []];
	private inFlight = 0;
	private realInFlight = 0;
	private bytesHeld = 0;

	private readonly freshUntil = new _Map<string, number>();
	readonly options: PrefetchOptions;

	readonly stats = { scheduled: 0, hits: 0, joined: 0, misses: 0, failed: 0 };

	constructor(
		private readonly handler: RamjetFetchHandler,
		options?: Partial<PrefetchOptions>,
	) {
		this.options = { ...DEFAULT_PREFETCH_OPTIONS, ...options };
	}

	schedule(source: RamjetFetchRequest, hints: PrefetchHint[]): void {
		this.handler.preconnector?.observe(source.rawUrl, hints);
		if (!this.options.enabled || hints.length === 0 || source.method !== "GET")
			return;
		this.expire();

		const prefix = this.handler.context.prefix.href;
		const isDocument =
			source.rawDestination === "document" ||
			source.rawDestination === "iframe";
		const referrer = source.rawUrl.href;

		const clientUrl = isDocument ? source.rawUrl : source.rawClientUrl;

		let images = 0;
		let fonts = 0;
		for (const hint of hints) {
			if (
				hint.destination === "image" &&
				++images > this.options.maxImagesPerSource
			)
				continue;
			if (
				hint.destination === "font" &&
				++fonts > this.options.maxFontsPerSource
			)
				continue;

			const hash = hint.url.indexOf("#");
			const url = hash < 0 ? hint.url : hint.url.slice(0, hash);
			if (!url.startsWith(prefix)) continue;
			const rest = url.slice(prefix.length);
			if (rest.startsWith("data:") || rest.startsWith("blob:")) continue;

			const key = keyOf(url, hint.destination, hint.mode);
			if ((this.freshUntil.get(url) ?? 0) > Date.now()) continue;
			const existing = this.entries.get(key);
			if (existing) {
				existing.refs++;
				continue;
			}
			if (this.entries.size >= this.options.maxEntries) break;

			let rawUrl: URL;
			try {
				rawUrl = new URL(url);
			} catch {
				continue;
			}

			const request: RamjetFetchRequest = {
				rawUrl,
				rawReferrer: referrer,
				rawDestination: hint.destination,
				mode: hint.mode,
				referrer,
				method: "GET",
				body: null,
				cache: "default",
				initialHeaders: this.headersFor(
					source.initialHeaders,
					hint.destination,
				),
				rawClientUrl: clientUrl,
				clientId: source.clientId,
				prefetch: true,
			};

			let resolve!: (s: Stored | null) => void;
			const promise = new Promise<Stored | null>((r) => (resolve = r));
			const entry: Entry = {
				key,
				refs: 1,
				created: Date.now(),
				promise,
				bytes: 0,
			};
			this.entries.set(key, entry);
			this.queues[PRIORITY[hint.destination] ?? 4].push({
				entry,
				request,
				resolve,
			});
			this.stats.scheduled++;
		}
		this.pump();
	}

	take(
		request: RamjetFetchRequest,
		parsed: RamjetFetchParsed,
	): Promise<RamjetFetchResponse | null> | null {
		if (request.prefetch || this.entries.size === 0) return null;
		if (request.method !== "GET" || request.cache !== "default" || request.body)
			return null;
		if (request.initialHeaders.has("range")) return null;

		const key = keyOf(request.rawUrl.href, parsed.destination, request.mode);
		const entry = this.entries.get(key);
		if (!entry) {
			this.stats.misses++;
			return null;
		}
		if (--entry.refs <= 0) this.drop(entry);

		const settled = this.settled.has(entry);
		return entry.promise.then((stored) => {
			if (!stored) return null;
			if (settled) this.stats.hits++;
			else this.stats.joined++;
			return this.materialize(stored);
		});
	}

	beginReal(): void {
		this.realInFlight++;
	}

	endReal(): void {
		this.realInFlight--;
		this.pump();
	}

	cancelQueued(): void {
		for (const queue of this.queues) {
			for (const job of queue) this.drop(job.entry);
			queue.length = 0;
		}
	}

	observe(url: string, headers: RamjetHeaders): void {
		const cc = (headers.get("cache-control") ?? "").toLowerCase();
		if (!cc || cc.includes("no-store") || cc.includes("no-cache")) return;
		const maxAge = /max-age=(\d+)/.exec(cc);
		const seconds = maxAge
			? Number(maxAge[1])
			: cc.includes("immutable")
				? 3600
				: 0;
		if (seconds <= 0) return;
		if (this.freshUntil.size >= 4000) this.freshUntil.clear();
		this.freshUntil.set(url, Date.now() + Math.min(seconds, 3600) * 1000);
	}

	clear(): void {
		for (const queue of this.queues) queue.length = 0;
		this.entries.clear();
		this.bytesHeld = 0;
	}

	private readonly settled = new WeakSet<Entry>();

	private headersFor(
		base: RamjetHeaders,
		destination: RequestDestination,
	): RamjetHeaders {
		const headers = base.clone();
		for (const name of STRIP_HEADERS) headers.delete(name);
		headers.set("Accept", ACCEPT[destination] ?? "*/*");
		return headers;
	}

	private pump(): void {
		const limit =
			this.realInFlight > 0
				? this.options.maxConcurrentWhenBusy
				: this.options.maxConcurrent;
		while (this.inFlight < limit) {
			const job = this.nextJob();
			if (!job) return;
			this.inFlight++;
			void this.run(job).finally(() => {
				this.inFlight--;
				this.pump();
			});
		}
	}

	private nextJob(): Job | undefined {
		for (const queue of this.queues) {
			while (queue.length) {
				const job = queue.shift()!;

				if (this.entries.get(job.entry.key) === job.entry) return job;
				job.resolve(null);
			}
		}
		return undefined;
	}

	private async run(job: Job): Promise<void> {
		let stored: Stored | null = null;
		try {
			const response = await this.handler.handleFetch(job.request);
			stored = await this.store(response);
		} catch {
			this.stats.failed++;
		}
		if (stored && this.entries.get(job.entry.key) === job.entry) {
			job.entry.bytes = stored.bytes;
			this.bytesHeld += stored.bytes;
			this.settled.add(job.entry);
			this.evictOverBudget();
		} else if (!stored) {
			this.drop(job.entry);
		}
		job.resolve(stored);
	}

	private async store(response: RamjetFetchResponse): Promise<Stored | null> {
		const { body } = response;
		const max = this.options.maxEntryBytes;
		let stored: StoredBody = null;
		let bytes = 0;

		if (body === undefined || body === null) {
			stored = null;
		} else if (typeof body === "string") {
			bytes = body.length * 2;
			if (bytes > max) return null;
			stored = body;
		} else if (body instanceof ArrayBuffer) {
			bytes = body.byteLength;
			if (bytes > max) return null;
			stored = body.slice(0);
		} else if (ArrayBuffer.isView(body)) {
			const view = body as ArrayBufferView;
			bytes = view.byteLength;
			if (bytes > max) return null;
			stored = view.buffer.slice(
				view.byteOffset,
				view.byteOffset + view.byteLength,
			) as ArrayBuffer;
		} else if (typeof Blob !== "undefined" && body instanceof Blob) {
			if (body.size > max) return null;
			stored = await body.arrayBuffer();
			bytes = stored.byteLength;
		} else if (typeof (body as ReadableStream).getReader === "function") {
			const declared = Number(response.headers.get("content-length"));
			if (declared > max) {
				void (body as ReadableStream).cancel().catch(() => {});
				return null;
			}
			const reader = (body as ReadableStream<Uint8Array>).getReader();
			const chunks: Uint8Array[] = [];
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > max) {
					void reader.cancel().catch(() => {});
					return null;
				}
				chunks.push(value);
			}
			const joined = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) {
				joined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			stored = joined.buffer;
		} else {
			return null;
		}

		return {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
			body: stored,
			bytes,
		};
	}

	private materialize(stored: Stored): RamjetFetchResponse {
		return {
			status: stored.status,
			statusText: stored.statusText,
			headers: stored.headers.clone(),
			body: (stored.body instanceof ArrayBuffer
				? stored.body.slice(0)
				: stored.body) as RamjetFetchResponse["body"],
		};
	}

	private drop(entry: Entry): void {
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
			this.bytesHeld -= entry.bytes;
		}
	}

	private expire(): void {
		const cutoff = Date.now() - this.options.ttlMs;
		for (const entry of this.entries.values()) {
			if (entry.created >= cutoff) break;
			this.drop(entry);
		}
	}

	private evictOverBudget(): void {
		if (this.bytesHeld <= this.options.maxBytes) return;
		for (const entry of this.entries.values()) {
			if (this.bytesHeld <= this.options.maxBytes) return;
			if (this.settled.has(entry)) this.drop(entry);
		}
	}
}

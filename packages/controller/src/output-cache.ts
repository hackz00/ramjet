export const OUTPUT_CACHE_PREFIX = "ramjet-out-v3";
const LEGACY_PREFIXES = ["ramjet-out-v1", "ramjet-out-v2"];

export function hashString(input: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x9e3779b9;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c ^ (i & 0xff), 0x85ebca6b) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export const FRESH_UNTIL_HEADER = "x-ramjet-fresh-until";

export const TOKEN_HEADER = "x-ramjet-token";

export const STORED_HEADER = "x-ramjet-stored";

export const SIZE_HEADER = "x-ramjet-size";
const INTERNAL_HEADERS = [
	FRESH_UNTIL_HEADER,
	TOKEN_HEADER,
	STORED_HEADER,
	SIZE_HEADER,
];
const TOKEN = "@RJ@";

const CACHEABLE_DESTINATIONS = new Set([
	"script",
	"style",
	"image",
	"font",
	"manifest",
	"track",
]);

const MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_HEURISTIC_MS = 24 * 60 * 60 * 1000;
const MIN_HEURISTIC_AGE_MS = 60 * 60 * 1000;
export const MAX_ENTRY_BYTES = 25 * 1024 * 1024;

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const TEXTUAL = /^(text\/|[^;]*(javascript|ecmascript|json|xml))/i;

export type HeaderGetter = (name: string) => string | null;

export type RequestShape = {
	url: string;
	method: string;
	mode: string;
	destination: string;

	cacheMode: string;
	hasRange: boolean;
	hasAuthorization: boolean;
};

export function cacheNameFor(
	generation: string,
	mode: string,
	destination = "script",
): string {
	return `${OUTPUT_CACHE_PREFIX}-${generation}:${mode === "cors" ? "cors" : "nocors"}:${destination}`;
}

export function isCacheableRequest(req: RequestShape): boolean {
	return (
		req.method === "GET" &&
		!req.hasRange &&
		!req.hasAuthorization &&
		(req.cacheMode === "default" || req.cacheMode === "force-cache") &&
		CACHEABLE_DESTINATIONS.has(req.destination)
	);
}

function varyIsSafe(vary: string | null): boolean {
	if (!vary) return true;
	return vary
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
		.every((h) => h === "accept-encoding");
}

export function freshnessLifetimeMs(
	get: HeaderGetter,
	nowMs: number,
): number | null {
	const cc = (get("cache-control") ?? "").toLowerCase();
	if (/\bno-store\b|\bno-cache\b/.test(cc)) return null;
	if (get("pragma")?.toLowerCase().includes("no-cache")) return null;
	if (!varyIsSafe(get("vary"))) return null;

	const max = /(?<![-\w])max-age=(\d+)/.exec(cc);

	let ms: number | null = null;
	if (max) {
		ms = Number(max[1]) * 1000;
	} else {
		const expires = get("expires");
		if (expires) {
			const at = Date.parse(expires);
			if (Number.isFinite(at)) {
				const date = Date.parse(get("date") ?? "");
				ms = at - (Number.isFinite(date) ? date : nowMs);
			}
		} else {
			const modified = Date.parse(get("last-modified") ?? "");
			const date = Date.parse(get("date") ?? "");
			if (Number.isFinite(modified)) {
				const age = (Number.isFinite(date) ? date : nowMs) - modified;
				if (age >= MIN_HEURISTIC_AGE_MS)
					ms = Math.min(age * 0.1, MAX_HEURISTIC_MS);
			}
		}
	}
	if (ms === null || !(ms > 0)) return null;

	const age = Number(get("age"));
	if (Number.isFinite(age) && age > 0) ms -= age * 1000;
	return ms > 0 ? Math.min(ms, MAX_LIFETIME_MS) : null;
}

export type StorePlan = { cacheName: string; freshUntil: number };

export function planStore(
	req: RequestShape,
	status: number,
	get: HeaderGetter,
	nowMs: number,
	generation: string,
): StorePlan | null {
	if (status !== 200 || !isCacheableRequest(req)) return null;
	const lifetime = freshnessLifetimeMs(get, nowMs);
	if (lifetime === null) return null;
	const length = Number(get("content-length"));
	if (Number.isFinite(length) && length > MAX_ENTRY_BYTES) return null;
	return {
		cacheName: cacheNameFor(generation, req.mode, req.destination),
		freshUntil: nowMs + lifetime,
	};
}

export type NormalizedUrl = {
	key: string;

	framePrefix: string;

	tokenPrefix: string;
	controllerId: string;
	frameId: string;
};

export function normalizeRequestUrl(
	url: string,
	controllerPrefix: string,
): NormalizedUrl | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!parsed.pathname.startsWith(controllerPrefix)) return null;
	const rest = parsed.pathname.slice(controllerPrefix.length);
	const slash = rest.indexOf("/");
	if (slash < 0) return null;

	const baseEnd = controllerPrefix.lastIndexOf(
		"/",
		controllerPrefix.length - 2,
	);
	const base = controllerPrefix.slice(0, baseEnd + 1);
	const tokenPrefix = `${base}${TOKEN}/`;
	return {
		key: parsed.origin + tokenPrefix + rest.slice(slash + 1) + parsed.search,
		framePrefix: controllerPrefix + rest.slice(0, slash + 1),
		tokenPrefix,
		controllerId: controllerPrefix.slice(baseEnd + 1, -1),
		frameId: rest.slice(0, slash),
	};
}

export type LookupContext = { controllerPrefix: string; generation: string };

type Entry = { cache: Cache; response: Response; normalized: NormalizedUrl };

async function findEntry(
	storage: Pick<CacheStorage, "open">,
	req: RequestShape,
	context: LookupContext,
): Promise<Entry | null> {
	if (!isCacheableRequest(req)) return null;
	const normalized = normalizeRequestUrl(req.url, context.controllerPrefix);
	if (!normalized) return null;
	const cache = await storage.open(
		cacheNameFor(context.generation, req.mode, req.destination),
	);
	const response = await cache.match(normalized.key, { ignoreVary: true });
	return response ? { cache, response, normalized } : null;
}

async function materialize(
	response: Response,
	normalized: NormalizedUrl,
): Promise<Response> {
	const headers = new Headers(response.headers);
	const tokenized = headers.get(TOKEN_HEADER) === "1";
	for (const name of INTERNAL_HEADERS) headers.delete(name);
	if (!tokenized) {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	const text = (await response.text())
		.split(normalized.tokenPrefix)
		.join(normalized.framePrefix);
	headers.delete("content-length");
	return new Response(text, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function lookupOutputCache(
	storage: Pick<CacheStorage, "open">,
	req: RequestShape,
	context: LookupContext,
	nowMs: number = Date.now(),
): Promise<Response | null> {
	const entry = await findEntry(storage, req, context);
	if (!entry) return null;
	const freshUntil = Number(entry.response.headers.get(FRESH_UNTIL_HEADER));
	if (!(freshUntil > nowMs)) return null;
	return materialize(entry.response, entry.normalized);
}

export type Validators = { etag?: string; lastModified?: string };

export type Stale = {
	validators: Validators;
	req: RequestShape;
	context: LookupContext;
};

export async function findRevalidatable(
	storage: Pick<CacheStorage, "open">,
	req: RequestShape,
	context: LookupContext,
	nowMs: number = Date.now(),
): Promise<Stale | null> {
	const entry = await findEntry(storage, req, context);
	if (!entry) return null;
	const freshUntil = Number(entry.response.headers.get(FRESH_UNTIL_HEADER));
	if (freshUntil > nowMs) return null;
	const etag = entry.response.headers.get("etag") ?? undefined;
	const lastModified = entry.response.headers.get("last-modified") ?? undefined;

	const lm =
		lastModified && Number.isFinite(Date.parse(lastModified))
			? lastModified
			: undefined;
	if (!etag && !lm) return null;
	return { validators: { etag, lastModified: lm }, req, context };
}

const KEEP_STORED = new Set([
	"content-length",
	"content-encoding",
	"content-type",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);

export type Revalidated = {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: string | ArrayBuffer;
};

export async function refreshFromNotModified(
	storage: Pick<CacheStorage, "open">,
	stale: Stale,
	notModified: [string, string][],
	nowMs: number = Date.now(),
): Promise<Revalidated | null> {
	const entry = await findEntry(storage, stale.req, stale.context);
	if (!entry) return null;

	const merged = new Headers(entry.response.headers);
	for (const [name, value] of notModified) {
		const lower = name.toLowerCase();
		if (KEEP_STORED.has(lower) || INTERNAL_HEADERS.includes(lower)) continue;
		merged.set(name, value);
	}
	const lifetime = freshnessLifetimeMs((n) => merged.get(n), nowMs);

	const stored = new Headers(merged);
	if (lifetime !== null) {
		stored.set(FRESH_UNTIL_HEADER, String(nowMs + lifetime));
		stored.set(STORED_HEADER, String(nowMs));

		await entry.cache
			.put(
				entry.normalized.key,
				new Response(entry.response.clone().body, {
					status: entry.response.status,
					statusText: entry.response.statusText,
					headers: stored,
				}),
			)
			.catch(() => {});
	} else {
		await entry.cache.delete(entry.normalized.key).catch(() => {});
	}

	const served = await materialize(
		new Response(entry.response.body, {
			status: entry.response.status,
			statusText: entry.response.statusText,
			headers: stored,
		}),
		entry.normalized,
	);
	const tokenized = entry.response.headers.get(TOKEN_HEADER) === "1";
	return {
		status: served.status,
		statusText: served.statusText,
		headers: [...served.headers],
		body: tokenized ? await served.text() : await served.arrayBuffer(),
	};
}

export type StoreTarget = StorePlan & NormalizedUrl;

type StorableBody =
	| string
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| ReadableStream<Uint8Array>;

async function readBytes(body: StorableBody): Promise<ArrayBuffer> {
	if (body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
			.buffer;
	return new Response(
		body as Blob | ReadableStream<Uint8Array> | string,
	).arrayBuffer();
}

export async function storeOutput(
	storage: Pick<CacheStorage, "open">,
	target: StoreTarget,
	status: number,
	statusText: string,
	headers: [string, string][],
	body: StorableBody | null,
	nowMs: number = Date.now(),
): Promise<void> {
	try {
		const stored = new Headers();
		let contentType = "";
		for (const [name, value] of headers) {
			const lower = name.toLowerCase();
			if (INTERNAL_HEADERS.includes(lower)) continue;
			if (lower === "content-type") contentType = value;
			stored.append(name, value);
		}

		let payload: BodyInit | null = null;
		let size = 0;
		if (body !== null) {
			const bytes = await readBytes(body);
			if (bytes.byteLength > MAX_ENTRY_BYTES) return;
			size = bytes.byteLength;
			payload = bytes;
			if (TEXTUAL.test(contentType)) {
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				} catch {
					return;
				}
				const parts = text.split(target.framePrefix);
				if (parts.length > 1) {
					text = parts.join(target.tokenPrefix);
					stored.set(TOKEN_HEADER, "1");
				}

				if (text.includes(target.frameId) || text.includes(target.controllerId))
					return;
				stored.delete("content-length");
				payload = text;
				size = new TextEncoder().encode(text).byteLength;
			}
		}
		stored.set(FRESH_UNTIL_HEADER, String(target.freshUntil));
		stored.set(STORED_HEADER, String(nowMs));
		stored.set(SIZE_HEADER, String(size));

		const cache = await storage.open(target.cacheName);
		await cache.put(
			target.key,
			new Response(payload, { status, statusText, headers: stored }),
		);
	} catch {}
}

export type SweepOptions = {
	limit?: number;

	maxBytes?: number;
};

export async function sweepOutputCache(
	storage: Pick<CacheStorage, "open" | "keys" | "delete">,
	_generation: string,
	nowMs: number = Date.now(),
	options: SweepOptions = {},
): Promise<number> {
	const limit = options.limit ?? 5000;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	let removed = 0;

	type Live = { cache: Cache; key: Request; size: number; stored: number };
	const live: Live[] = [];
	for (const name of await storage.keys()) {
		if (LEGACY_PREFIXES.some((p) => name.startsWith(p))) {
			await storage.delete(name);
			removed++;
			continue;
		}
		if (!name.startsWith(OUTPUT_CACHE_PREFIX)) continue;
		const cache = await storage.open(name);
		for (const key of (await cache.keys()).slice(0, limit)) {
			const response = await cache.match(key, { ignoreVary: true });
			const freshUntil = Number(response?.headers.get(FRESH_UNTIL_HEADER));
			if (!response || !(freshUntil > nowMs)) {
				await cache.delete(key);
				removed++;
				continue;
			}
			live.push({
				cache,
				key,
				size: Number(response.headers.get(SIZE_HEADER)) || 0,
				stored: Number(response.headers.get(STORED_HEADER)) || 0,
			});
		}
	}

	let total = live.reduce((sum, e) => sum + e.size, 0);
	if (total > maxBytes) {
		live.sort((a, b) => a.stored - b.stored);
		for (const entry of live) {
			if (total <= maxBytes) break;
			await entry.cache.delete(entry.key);
			total -= entry.size;
			removed++;
		}
	}
	return removed;
}

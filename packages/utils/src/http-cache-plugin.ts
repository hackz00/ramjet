import {
	BareResponse,
	type RamjetFetchRequest,
	type RamjetHeaders,
} from "@ramjet/core";
import { ManagedPlugin } from "@ramjet/controller";
import type { Frame } from "@ramjet/controller";

export const CACHE_NAME = "ramjet-http-cache-v2";

const STORED_AT_HEADER = "x-sj-cached-at";

const DEFAULT_CACHEABLE_STATUSES = new Set([
	200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501,
]);

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

interface CacheControlDirectives {
	"no-store"?: boolean;
	"no-cache"?: boolean;
	"must-revalidate"?: boolean;
	"proxy-revalidate"?: boolean;
	private?: boolean;
	public?: boolean;
	"max-age"?: number;
	"s-maxage"?: number;
	"stale-while-revalidate"?: number;
	"stale-if-error"?: number;
	immutable?: boolean;
}

function parseCacheControl(value: string | null): CacheControlDirectives {
	const out: CacheControlDirectives = {};
	if (!value) return out;
	for (const raw of value.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		const eq = part.indexOf("=");
		const name = (eq === -1 ? part : part.slice(0, eq))
			.trim()
			.toLowerCase() as keyof CacheControlDirectives;
		if (eq === -1) {
			(out as any)[name] = true;
			continue;
		}
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		if (
			name === "max-age" ||
			name === "s-maxage" ||
			name === "stale-while-revalidate" ||
			name === "stale-if-error"
		) {
			const n = parseInt(v, 10);
			if (Number.isFinite(n) && n >= 0) (out as any)[name] = n;
		} else {
			(out as any)[name] = true;
		}
	}
	return out;
}

function freshnessLifetimeSeconds(
	headers: Headers,
	cc: CacheControlDirectives,
	dateMs: number,
): number | null {
	if (cc["s-maxage"] !== undefined) return cc["s-maxage"];
	if (cc["max-age"] !== undefined) return cc["max-age"];

	const expires = headers.get("expires");
	if (expires) {
		const expMs = Date.parse(expires);
		if (Number.isFinite(expMs)) {
			return Math.max(0, (expMs - dateMs) / 1000);
		}
	}

	const lastModified = headers.get("last-modified");
	if (lastModified) {
		const lmMs = Date.parse(lastModified);
		if (Number.isFinite(lmMs) && lmMs <= dateMs) {
			return ((dateMs - lmMs) * 0.1) / 1000;
		}
	}

	return null;
}

function currentAgeSeconds(headers: Headers, storedAtMs: number): number {
	const ageHeader = headers.get("age");
	const initialAge = ageHeader ? parseInt(ageHeader, 10) || 0 : 0;
	const residentTime = (Date.now() - storedAtMs) / 1000;
	return initialAge + residentTime;
}

function isCacheableMethod(method: string): boolean {
	return method === "GET" || method === "HEAD";
}

function responseIsStorable(
	status: number,
	headers: Headers,
	method: string,
): boolean {
	if (!isCacheableMethod(method)) return false;
	if (!DEFAULT_CACHEABLE_STATUSES.has(status)) return false;

	const cc = parseCacheControl(headers.get("cache-control"));
	if (cc["no-store"]) return false;

	const vary = headers.get("vary");
	if (vary && vary.split(",").some((v) => v.trim() === "*")) return false;

	return true;
}

function buildCacheKeyRequest(
	parsedUrl: string,
	headers: RamjetHeaders,
): Request {
	const native = new Headers();
	for (const [k, v] of headers.toRawHeaders()) {
		try {
			native.append(k, v);
		} catch {}
	}
	const cacheKeyUrl =
		"https://sj-cache.invalid/" + encodeURIComponent(parsedUrl);
	return new Request(cacheKeyUrl, { method: "GET", headers: native });
}

function nativeHeadersFromRaw(
	raw: ReadonlyArray<readonly [string, string]>,
): Headers {
	const h = new Headers();
	for (const [k, v] of raw) {
		try {
			h.append(k, v);
		} catch {}
	}
	return h;
}

function strippedHeadersFromStored(stored: Response): Headers {
	const out = new Headers();
	for (const [k, v] of stored.headers.entries()) {
		if (k.toLowerCase() === STORED_AT_HEADER) continue;
		try {
			out.append(k, v);
		} catch {}
	}
	return out;
}

async function rebuildBareResponseWithBuffer(
	bare: BareResponse,
): Promise<{ replacement: BareResponse; bodyBuffer: ArrayBuffer | null }> {
	const status = bare.status;
	const isNullBody = NULL_BODY_STATUSES.has(status);

	const headers = nativeHeadersFromRaw(bare.rawHeaders);

	if (isNullBody) {
		return {
			replacement: BareResponse.fromNativeResponse(
				new Response(null, {
					status,
					statusText: bare.statusText,
					headers,
				}),
			),
			bodyBuffer: null,
		};
	}

	const buf = await bare.arrayBuffer();
	return {
		replacement: BareResponse.fromNativeResponse(
			new Response(buf, {
				status,
				statusText: bare.statusText,
				headers,
			}),
		),
		bodyBuffer: buf,
	};
}

function buildStorableResponse(
	body: ArrayBuffer | null,
	status: number,
	statusText: string,
	rawHeaders: ReadonlyArray<readonly [string, string]>,
): Response {
	const native = nativeHeadersFromRaw(rawHeaders);
	native.set(STORED_AT_HEADER, String(Date.now()));
	return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
		status,
		statusText,
		headers: native,
	});
}

export interface HttpCachePluginOptions {
	cacheName?: string;
}

export class HttpCachePlugin extends ManagedPlugin {
	readonly cacheName: string;

	private cachePromise: Promise<Cache> | null = null;

	private cameFromCache = new WeakMap<RamjetFetchRequest, true>();

	constructor(options: HttpCachePluginOptions = {}) {
		super("ramjet-http-cache", []);
		this.cacheName = options.cacheName ?? CACHE_NAME;
	}

	private openCache(): Promise<Cache> {
		if (!this.cachePromise) {
			this.cachePromise = caches.open(this.cacheName);
		}
		return this.cachePromise;
	}

	install(frame: Frame): void {
		super.install(frame);

		const hooks = frame.fetchHandler.hooks.fetch;

		this.tap(hooks.request, async (ctx, props) => {
			const req = ctx.request;
			if (!isCacheableMethod(req.method)) return;
			const reqCache = req.cache as string;

			if (reqCache === "no-store" || reqCache === "reload") return;

			if (props.earlyResponse) return;

			const cache = await this.openCache();
			const stored = await cache.match(
				buildCacheKeyRequest(ctx.parsed.url.href, req.initialHeaders),
			);
			if (!stored) {
				return;
			}

			const storedAt = parseInt(
				stored.headers.get(STORED_AT_HEADER) ?? "0",
				10,
			);
			const cc = parseCacheControl(stored.headers.get("cache-control"));

			const pragmaNoCache = (stored.headers.get("pragma") ?? "")
				.toLowerCase()
				.includes("no-cache");
			const mustRevalidateBeforeUse =
				cc["no-cache"] === true || pragmaNoCache || reqCache === "no-cache";

			const dateMs = (() => {
				const d = stored.headers.get("date");
				if (d) {
					const v = Date.parse(d);
					if (Number.isFinite(v)) return v;
				}
				return storedAt || Date.now();
			})();

			const lifetime = freshnessLifetimeSeconds(stored.headers, cc, dateMs);
			const age = currentAgeSeconds(stored.headers, storedAt);
			const fresh =
				!mustRevalidateBeforeUse && lifetime !== null && age < lifetime;

			const immutable =
				cc.immutable === true &&
				reqCache !== "no-cache" &&
				reqCache !== "reload";

			if (!fresh && !immutable) {
				return;
			}

			const headers = strippedHeadersFromStored(stored);

			if (storedAt) {
				headers.set("age", String(Math.floor((Date.now() - storedAt) / 1000)));
			}

			const isNullBody = NULL_BODY_STATUSES.has(stored.status);
			const earlyBody = isNullBody ? null : await stored.arrayBuffer();

			const earlyResponse = BareResponse.fromNativeResponse(
				new Response(earlyBody, {
					status: stored.status,
					statusText: stored.statusText,
					headers,
				}),
			);

			this.cameFromCache.set(req, true);
			props.earlyResponse = earlyResponse;
		});

		this.tap(hooks.preresponse, async (ctx, props) => {
			const req = ctx.request;

			if (this.cameFromCache.has(req)) {
				this.cameFromCache.delete(req);
				return;
			}

			if ((req.cache as string) === "no-store") return;
			if (!isCacheableMethod(req.method)) return;

			const headers = nativeHeadersFromRaw(props.response.rawHeaders);
			if (!responseIsStorable(props.response.status, headers, req.method))
				return;

			const { replacement, bodyBuffer } = await rebuildBareResponseWithBuffer(
				props.response,
			);
			props.response = replacement;

			const cacheKey = buildCacheKeyRequest(
				ctx.parsed.url.href,
				req.initialHeaders,
			);
			const toStore = buildStorableResponse(
				bodyBuffer,
				props.response.status,
				props.response.statusText,
				props.response.rawHeaders,
			);

			try {
				const cache = await this.openCache();
				await cache.put(cacheKey, toStore);
			} catch (err) {
				console.warn("[ramjet-http-cache] cache.put failed:", err);
			}
		});
	}

	async bust(): Promise<boolean> {
		try {
			this.cachePromise = null;
			return await caches.delete(this.cacheName);
		} catch (err) {
			console.error("[ramjet-http-cache] bust failed:", err);
			return false;
		}
	}
}

import {
	rewriteUrl,
	RamjetContext,
	RamjetHeaders,
	unrewriteUrl,
	URLMeta,
} from "@/shared";
import { RamjetFetchHandler, RamjetFetchParsed, RamjetFetchRequest } from ".";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { _URL, _Set } from "@/shared/snapshot";
import { createReferrerString } from "./util";

const SEC_HEADERS = new _Set([
	"cross-origin-embedder-policy",
	"cross-origin-opener-policy",
	"cross-origin-resource-policy",
	"content-security-policy",
	"content-security-policy-report-only",
	"expect-ct",
	"feature-policy",
	"origin-isolation",
	"strict-transport-security",
	"upgrade-insecure-requests",
	"x-content-type-options",
	"x-download-options",
	"x-frame-options",
	"x-permitted-cross-domain-policies",
	"x-powered-by",
	"x-xss-protection",

	// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Clear-Site-Data
	"clear-site-data",
]) as _Set<string>;

const URL_HEADERS = new _Set([
	"location",
	"content-location",
	"referer",
]) as _Set<string>;

export function rewriteLinkHeader(
	link: string,
	context: RamjetContext,
	meta: URLMeta,
) {
	return link.replace(
		/<([^>]*)>|"(?:\\.|[^"\\])*"|;\s*integrity\s*=\s*(?:"(?:\\.|[^"\\])*"|[^;,\s]*)/gi,
		(match, url: string | undefined) =>
			url !== undefined
				? `<${rewriteUrl(url, context, meta)}>`
				: match.startsWith(";")
					? ""
					: match,
	);
}

export async function rewriteResponseHeaders(
	handler: RamjetFetchHandler,
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
	rawHeaders: RawHeaders,
): Promise<RamjetHeaders> {
	const headers = RamjetHeaders.fromRawHeaders(rawHeaders);

	for (const cspHeader of SEC_HEADERS) {
		headers.delete(cspHeader);
	}

	for (const urlHeader of URL_HEADERS) {
		if (headers.has(urlHeader)) {
			const url = headers.get(urlHeader)!;
			const rewrittenUrl = rewriteUrl(url, handler.context, parsed.meta);
			headers.set(urlHeader, rewrittenUrl);
		}
	}

	if (headers.has("link")) {
		const link = headers.get("link")!;
		const rewritten = rewriteLinkHeader(link, handler.context, parsed.meta);
		headers.set("link", rewritten);
	}

	if (headers.get("accept") === "text/event-stream") {
		headers.set("content-type", "text/event-stream");
	}

	headers.delete("permissions-policy");

	headers.delete("set-cookie");

	if (
		handler.crossOriginIsolated &&
		[
			"document",
			"iframe",
			"worker",
			"sharedworker",
			"style",
			"script",
		].includes(parsed.destination)
	) {
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
	}

	if (parsed.destination === "document" || parsed.destination === "iframe") {
		headers.set("Referrer-Policy", "unsafe-url");
	}

	return headers;
}

export function rewriteRequestHeaders(
	request: RamjetFetchRequest,
	handler: RamjetFetchHandler,
	parsed: RamjetFetchParsed,
): RamjetHeaders {
	const headers = request.initialHeaders.clone();

	headers.delete("Referer");

	const rawOriginUrl =
		parsed.referrerSourceUrl !== undefined
			? parsed.referrerSourceUrl
			: request.rawClientUrl ||
				(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	const originUrl =
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
			? new _URL(unrewriteUrl(rawOriginUrl, handler.context))
			: rawOriginUrl;

	if (
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
	) {
		headers.set("Origin", originUrl.origin);

		const referer = createReferrerString(
			originUrl,
			parsed.url,
			parsed.referrerPolicy ?? null,
		);
		if (referer) headers.set("Referer", referer);
	}

	const sameSiteContext = computeSameSiteContext(request, parsed, originUrl);
	const cookies = handler.context.cookieJar.getCookies(
		parsed.url,
		false,
		sameSiteContext,
	);

	if (cookies.length) {
		headers.set("Cookie", cookies);
	}

	applyFetchMetadataHeaders(headers, request, parsed, handler);

	return headers;
}

/**
 * Compute and attach the Sec-Fetch-* request metadata headers, per
 * https://w3c.github.io/webappsec-fetch-metadata/.
 *
 * Browsers compute these based on the proxy URL space (page → service worker),
 * which is meaningless to the destination. We strip those values and recompute
 * based on the logical (unrewritten) URLs so that the destination sees
 * realistic Sec-Fetch-Site / -Mode / -Dest / -User values.
 *
 * These headers are only attached when the destination URL is a "potentially
 * trustworthy" URL — matching Chrome's behaviour of omitting them when sending
 * to plain http:// non-loopback destinations.
 */
function applyFetchMetadataHeaders(
	headers: RamjetHeaders,
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
	handler: RamjetFetchHandler,
) {
	headers.delete("sec-fetch-site");
	headers.delete("sec-fetch-mode");
	headers.delete("sec-fetch-dest");
	headers.delete("sec-fetch-user");
	headers.delete("sec-fetch-storage-access");

	if (!isPotentiallyTrustworthy(parsed.url)) {
		return;
	}

	const initiatorUrl = resolveFetchInitiatorUrl(request, parsed, handler);

	let site: "none" | "same-origin" | "same-site" | "cross-site";
	if (!initiatorUrl) {
		site = "none";
	} else {
		const immediate = computeFetchSite(initiatorUrl, parsed.url);
		site = parsed.fetchSiteState
			? worstFetchSite(parsed.fetchSiteState, immediate)
			: immediate;
	}
	headers.set("Sec-Fetch-Site", site);

	headers.set("Sec-Fetch-Mode", computeFetchMode(request, parsed));

	if (parsed.destination === "iframe") {
		if (!parsed.isIframe) {
			headers.set("Sec-Fetch-Dest", "document");
		} else {
			headers.set("Sec-Fetch-Dest", "iframe");
		}
	} else {
		headers.set("Sec-Fetch-Dest", parsed.destination || "empty");
	}

	const isNavigationDestination =
		parsed.destination === "document" ||
		parsed.destination === "iframe" ||
		parsed.destination === "frame" ||
		parsed.destination === "embed" ||
		parsed.destination === "object";
	if (
		isNavigationDestination &&
		request.initialHeaders.get("sec-fetch-user") === "?1"
	) {
		headers.set("Sec-Fetch-User", "?1");
	}

	// Sec-Fetch-Storage-Access: per https://privacycg.github.io/storage-access-headers/.

	if (site === "cross-site" && requestIncludesCredentials(request, parsed)) {
		headers.set("Sec-Fetch-Storage-Access", "none");
	}
}

function requestIncludesCredentials(
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
): boolean {
	if (parsed.fetchCredentialsInclude) return true;
	const dest = parsed.destination;

	if (dest === "" || dest === "report") return false;

	if (parsed.isModule) return false;

	return true;
}

function computeFetchMode(
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
): string {
	if (parsed.fetchMode) return parsed.fetchMode;
	const dest = parsed.destination;
	if (
		dest === "document" ||
		dest === "iframe" ||
		dest === "frame" ||
		dest === "embed" ||
		dest === "object"
	) {
		return "navigate";
	}
	if (dest === "worker" || dest === "sharedworker") {
		return parsed.isModule ? "cors" : "same-origin";
	}

	if (request.mode === "cors" || request.mode === "no-cors") {
		return request.mode;
	}
	return "no-cors";
}

function resolveFetchInitiatorUrl(
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
	handler: RamjetFetchHandler,
): URL | undefined {
	if (parsed.fetchInitiatorOrigin) {
		try {
			return new _URL(parsed.fetchInitiatorOrigin);
		} catch {}
	}
	const candidate =
		request.rawClientUrl ||
		(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	if (!candidate) return undefined;
	if (candidate.pathname.startsWith(handler.context.prefix.pathname)) {
		return new _URL(unrewriteUrl(candidate, handler.context));
	}

	return undefined;
}

/**
 * Whether a URL is "potentially trustworthy" per
 * https://w3c.github.io/webappsec-secure-contexts/#is-url-trustworthy.
 *
 * This is a slimmed-down implementation: HTTPS / WSS, file:, and the common
 * loopback hostnames (localhost, *.localhost, 127.0.0.0/8, ::1) are treated as
 * trustworthy. Everything else (including plain http:// to a real hostname) is
 * not.
 */
function isPotentiallyTrustworthy(url: URL): boolean {
	const protocol = url.protocol;
	if (protocol === "https:" || protocol === "wss:" || protocol === "file:") {
		return true;
	}
	if (protocol !== "http:" && protocol !== "ws:") {
		return false;
	}
	return isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "localhost.") return true;
	if (hostname.endsWith(".localhost") || hostname.endsWith(".localhost.")) {
		return true;
	}
	if (hostname === "[::1]" || hostname === "::1") return true;

	if (/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(hostname)) {
		return true;
	}
	return false;
}

export function computeFetchSite(
	originUrl: URL,
	destUrl: URL,
): "same-origin" | "same-site" | "cross-site" {
	if (
		originUrl.protocol === destUrl.protocol &&
		originUrl.host === destUrl.host
	) {
		return "same-origin";
	}
	if (
		originUrl.protocol === destUrl.protocol &&
		registrableDomain(originUrl.hostname) ===
			registrableDomain(destUrl.hostname)
	) {
		return "same-site";
	}
	return "cross-site";
}

export function worstFetchSite(
	a: "none" | "same-origin" | "same-site" | "cross-site",
	b: "none" | "same-origin" | "same-site" | "cross-site",
): "none" | "same-origin" | "same-site" | "cross-site" {
	const order = { "cross-site": 0, "same-site": 1, "same-origin": 2, none: 3 };
	return order[a] <= order[b] ? a : b;
}

function computeSameSiteContext(
	request: RamjetFetchRequest,
	parsed: RamjetFetchParsed,
	rawOriginUrl: URL | undefined,
): "strict" | "lax" | "cross-site" {
	if (parsed.crossSiteRedirect) {
		const isNavigation =
			parsed.destination === "document" || parsed.destination === "iframe";
		const isSafeMethod = request.method === "GET" || request.method === "HEAD";
		return isNavigation && isSafeMethod ? "lax" : "cross-site";
	}

	if (!rawOriginUrl) return "strict";

	const originSite = registrableDomain(rawOriginUrl.hostname);
	const targetSite = registrableDomain(parsed.url.hostname);

	if (originSite === targetSite) return "strict";

	const isNavigation =
		parsed.destination === "document" || parsed.destination === "iframe";
	const isSafeMethod = request.method === "GET" || request.method === "HEAD";

	if (isNavigation && isSafeMethod) return "lax";
	return "cross-site";
}

function registrableDomain(hostname: string): string {
	if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;

	const labels = hostname.split(".");
	if (labels.length <= 1) return hostname;

	if (labels[0] === "www") return labels.slice(1).join(".");

	if (labels.length === 2) return hostname;

	return labels.slice(-2).join(".");
}

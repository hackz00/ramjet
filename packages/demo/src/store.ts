import { createStore } from "dreamland/core";

export type AvailableTransports = "assisted" | "libcurl" | "epoxy";

export const AVAILABLE_TRANSPORTS: ReadonlyArray<{
	value: AvailableTransports;
	label: string;
}> = [
	{ value: "assisted", label: "Assisted (fastest, server can read traffic)" },
	{ value: "libcurl", label: "Libcurl (end-to-end encrypted)" },
	{ value: "epoxy", label: "Epoxy" },
];
const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
	location.hostname,
);
const websocketOrigin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
const DEFAULT_WISP_URL =
	import.meta.env.VITE_WISP_URL ||
	(localHost ? "ws://localhost:4142/" : `${websocketOrigin}/wisp/`);
const DEFAULT_ASSISTED_URL =
	import.meta.env.VITE_ASSISTED_URL ||
	(localHost ? "ws://localhost:4143/assisted" : `${websocketOrigin}/assisted`);
const DEFAULT_TRANSPORT: AvailableTransports = "assisted";
const DEFAULT_HOME_URL = "https://duckduckgo.com/";
const DEFAULT_MAX_REQUESTS = 200;

export const demoSettingsStore = createStore(
	{
		transport: DEFAULT_TRANSPORT as AvailableTransports,
		wispUrl: DEFAULT_WISP_URL,
		assistedUrl: DEFAULT_ASSISTED_URL,
		homeUrl: DEFAULT_HOME_URL,
		maxRequests: DEFAULT_MAX_REQUESTS,
	},
	{
		ident: "ramjet-demo-settings",
		backing: "localstorage",
		autosave: "auto",
	},
);

demoSettingsStore.wispUrl ??= DEFAULT_WISP_URL;
demoSettingsStore.assistedUrl ??= DEFAULT_ASSISTED_URL;

export function normalizeAssistedUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) throw new TypeError("Assisted server URL is required.");
	const parsed = new URL(trimmed);
	if (!["ws:", "wss:"].includes(parsed.protocol)) {
		throw new TypeError("Assisted server URL must use ws:// or wss://.");
	}
	if (parsed.username || parsed.password) {
		throw new TypeError(
			"Assisted server URL cannot contain login credentials.",
		);
	}
	if (parsed.pathname === "/") parsed.pathname = "/assisted";
	return parsed.toString();
}

export function normalizeWispUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new TypeError("Wisp URL is required.");
	}

	let normalized = trimmed;
	if (!normalized.startsWith("ws://") && !normalized.startsWith("wss://")) {
		normalized = `ws://${normalized}`;
	}

	const parsed = new URL(normalized);
	if (!parsed.pathname || parsed.pathname === "") {
		parsed.pathname = "/";
	}
	if (!parsed.pathname.endsWith("/")) {
		parsed.pathname = `${parsed.pathname}/`;
	}

	return parsed.toString();
}

export function normalizeHomeUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new TypeError("Home page URL is required.");
	}

	const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	return new URL(normalized).toString();
}

export function normalizeTransport(value: string): AvailableTransports {
	if (AVAILABLE_TRANSPORTS.some((t) => t.value === value)) {
		return value as AvailableTransports;
	}
	throw new TypeError(`Unknown transport: ${value}`);
}

export function normalizeMaxRequests(value: string | number) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new TypeError("Request log limit must be a number.");
	}

	const rounded = Math.round(parsed);
	if (rounded < 10 || rounded > 5000) {
		throw new RangeError("Request log limit must be between 10 and 5000.");
	}

	return rounded;
}

export const demoSettingsDefaults = {
	wispUrl: normalizeWispUrl(DEFAULT_WISP_URL),
	assistedUrl: normalizeAssistedUrl(DEFAULT_ASSISTED_URL),
	transport: DEFAULT_TRANSPORT,
	homeUrl: normalizeHomeUrl(DEFAULT_HOME_URL),
	maxRequests: DEFAULT_MAX_REQUESTS,
};

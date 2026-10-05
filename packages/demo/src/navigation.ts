export function resolveAddress(input: string): string {
	const value = input.trim();
	if (!value) throw new Error("Enter a URL or search terms.");
	const host = /^(?:localhost|[^\s/]+\.[^\s/]+)(?::\d+)?(?:[/?#]|$)/i.test(
		value,
	);
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^localhost:\d+/i.test(value)) {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("Use an HTTP or HTTPS website URL.");
		return url.href;
	}
	return host
		? new URL(`https://${value}`).href
		: `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

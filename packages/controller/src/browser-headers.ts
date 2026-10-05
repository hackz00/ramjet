type Brand = { brand: string; version: string };

export type NavigatorLike = {
	languages?: readonly string[];
	language?: string;
	userAgentData?: {
		brands?: readonly Brand[];
		mobile?: boolean;
		platform?: string;
	};
};

export function acceptLanguage(
	languages: readonly string[] | undefined,
): string | null {
	const list = (languages ?? []).filter(Boolean);
	if (list.length === 0) return null;
	return list
		.slice(0, 5)
		.map((tag, i) => (i === 0 ? tag : `${tag};q=${(1 - i * 0.1).toFixed(1)}`))
		.join(",");
}

const quote = (text: string) =>
	`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function clientHints(
	data: NavigatorLike["userAgentData"],
): Record<string, string> | null {
	if (!data?.brands?.length) return null;
	const hints: Record<string, string> = {
		"sec-ch-ua": data.brands
			.map((b) => `${quote(b.brand)};v=${quote(b.version)}`)
			.join(", "),
		"sec-ch-ua-mobile": data.mobile ? "?1" : "?0",
	};
	if (data.platform) hints["sec-ch-ua-platform"] = quote(data.platform);
	return hints;
}

export function browserHeaders(
	target: URL,
	nav: NavigatorLike | undefined,
): [string, string][] {
	if (!nav) return [];
	const out: [string, string][] = [];
	const language = acceptLanguage(
		nav.languages?.length ? nav.languages : nav.language ? [nav.language] : [],
	);
	if (language) out.push(["accept-language", language]);
	if (target.protocol === "https:") {
		const hints = clientHints(nav.userAgentData);
		if (hints) out.push(...Object.entries(hints));
	}
	return out;
}

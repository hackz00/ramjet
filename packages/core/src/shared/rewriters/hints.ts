export type PrefetchHint = {
	url: string;
	destination: RequestDestination;
	mode: RequestMode;
};

let active: PrefetchHint[] | null = null;

export function collectPrefetchHints<T>(sink: PrefetchHint[], fn: () => T): T {
	const previous = active;
	active = sink;
	try {
		return fn();
	} finally {
		active = previous;
	}
}

export function collecting(): boolean {
	return active !== null;
}

export function notePrefetchHint(hint: PrefetchHint): void {
	if (active) active.push(hint);
}

const PRELOAD_AS: Record<string, RequestDestination> = {
	style: "style",
	script: "script",
	font: "font",
	image: "image",
};

export function noteHtmlResource(
	tag: string,
	attr: string,
	rewritten: string,
	attrs: Record<string, string | undefined>,
): void {
	if (!active) return;
	const crossorigin = attrs.crossorigin !== undefined;
	if (tag === "link" && attr === "href") {
		const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
		if (rel.includes("stylesheet")) {
			if (attrs.media && attrs.media.toLowerCase() === "print") return;
			active.push({
				url: rewritten,
				destination: "style",
				mode: crossorigin ? "cors" : "no-cors",
			});
		} else if (rel.includes("modulepreload")) {
			active.push({ url: rewritten, destination: "script", mode: "cors" });
		} else if (rel.includes("preload")) {
			const destination = PRELOAD_AS[(attrs.as ?? "").toLowerCase()];
			if (!destination) return;

			active.push({
				url: rewritten,
				destination,
				mode: destination === "font" || crossorigin ? "cors" : "no-cors",
			});
		}
		return;
	}
	if (tag === "script" && attr === "src") {
		const module = (attrs.type ?? "").toLowerCase() === "module";
		active.push({
			url: rewritten,
			destination: "script",
			mode: module || crossorigin ? "cors" : "no-cors",
		});
		return;
	}
	if (tag === "img" && attr === "src") {
		if ((attrs.loading ?? "").toLowerCase() === "lazy") return;
		active.push({
			url: rewritten,
			destination: "image",
			mode: crossorigin ? "cors" : "no-cors",
		});
	}
}

export type CssUrlKind = "import" | "font" | "image";

export function noteCssResource(rewritten: string, kind: CssUrlKind): void {
	if (!active) return;
	if (kind === "import")
		active.push({ url: rewritten, destination: "style", mode: "no-cors" });
	else if (kind === "font")
		active.push({ url: rewritten, destination: "font", mode: "cors" });
	else active.push({ url: rewritten, destination: "image", mode: "no-cors" });
}

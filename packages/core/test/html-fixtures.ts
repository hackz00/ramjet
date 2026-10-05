import { beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomHandler, Element } from "domhandler";
import { Tap } from "@/Tap";
import { setWasmModule } from "@rewriters/wasm";
import { rewriteHtml } from "@rewriters/html";
import { StreamingHtmlRewriter } from "@rewriters/html-stream";

const here = path.dirname(fileURLToPath(import.meta.url));

const flags = {
	syncxhr: false,
	disableComputedWrap: false,
	rewriterLogs: false,
	captureErrors: false,
	cleanErrors: false,
	scramitize: false,
	sourcemaps: false,
	destructureRewrites: true,
	allowInvalidJs: true,
	debugTrampolines: false,
	allowFailedIntercepts: false,
	encapsulateWorkers: true,
	debugSourceURL: false,
};

export const script = (src: string) => new Element("script", { src, "ramjet-injected": "true" });
export const hooks = { rewriter: { html: Tap.create() } } as any;
export const context = {
	config: {
		flags,
		siteFlags: {},
		globals: {
			wrapfn: "$ramjet$wrap",
			wrappropertybase: "$ramjet__",
			wrappropertyfn: "$ramjet$prop",
			cleanrestfn: "$ramjet$clean",
			importfn: "$ramjet$import",
			rewritefn: "$ramjet$rewrite",
			metafn: "$ramjet$meta",
			wrappostmessagefn: "$ramjet$wrappostmessage",
			pushsourcemapfn: "$ramjet$pushsourcemap",
			trysetfn: "$ramjet$tryset",
			templocid: "$ramjet$temploc",
			tempunusedid: "$ramjet$tempunused",
		},
	},
	prefix: new URL("http://p.test/~/sj/f1/"),
	hooks,
	interface: {
		codecEncode: (s: string) => encodeURIComponent(s),
		codecDecode: (s: string) => decodeURIComponent(s),
		getInjectScripts: (_meta: unknown, _handler: unknown, _hc: unknown, make: (src: string) => Element) => [
			make("http://p.test/ramjet.js"),
			make("http://p.test/inject.js"),
		],
	},
} as any;

export const htmlcontext = { loadScripts: true, inline: true, source: "http://site.test/dir/page.html", headers: [], history: [] } as any;
export const newMeta = () => ({ origin: new URL("http://site.test/"), base: new URL("http://site.test/dir/page.html") }) as any;

export function reference(html: string): string {
	return rewriteHtml(html, context, newMeta(), htmlcontext);
}

export function streamed(html: string, chunk: number): string {
	const meta = newMeta();
	const rewriter = new StreamingHtmlRewriter(context, meta, htmlcontext, () =>
		context.interface.getInjectScripts(meta, new DomHandler(), htmlcontext, script)
	);
	let out = "";
	for (let i = 0; i < html.length; i += chunk) out += rewriter.write(html.slice(i, i + chunk));
	return out + rewriter.end();
}

beforeAll(async () => {
	setWasmModule(await WebAssembly.compile(readFileSync(path.join(here, "../dist/ramjet.wasm"))));
});


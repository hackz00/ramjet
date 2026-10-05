import { RamjetConfig, RamjetFlags, RamjetVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieJar } from "./cookie";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";
import { _RegExp } from "./snapshot";
import { BoundedLru } from "./memo";

export * from "./cookie";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./rewriters";

const siteFlagRegexes = new BoundedLru<string, RegExp>(256);
function siteFlagRegex(source: string): RegExp {
	let re = siteFlagRegexes.get(source);
	if (!re) {
		re = new _RegExp(source) as unknown as RegExp;
		siteFlagRegexes.set(source, re);
	}
	return re;
}

export function flagEnabled(
	flag: keyof RamjetFlags,
	context: RamjetContext,
	url: URL,
): boolean {
	const value = context.config.flags[flag];
	for (const regex in context.config.siteFlags) {
		const partialflags = context.config.siteFlags[regex];
		if (siteFlagRegex(regex).test(url.href) && flag in partialflags) {
			return partialflags[flag];
		}
	}

	return value;
}

export function resolveFlags(
	context: RamjetContext,
	url: URL,
): Record<string, boolean> {
	const resolved: Record<string, boolean> = { ...context.config.flags };
	const siteFlags = context.config.siteFlags;
	const decided: Record<string, true> = {};
	for (const regex in siteFlags) {
		if (!siteFlagRegex(regex).test(url.href)) continue;
		const partialflags = siteFlags[regex];
		for (const flag in partialflags) {
			if (decided[flag]) continue;
			decided[flag] = true;
			resolved[flag] = partialflags[flag as keyof RamjetFlags] as boolean;
		}
	}
	return resolved;
}
export type RamjetInterface = {
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;

	getInjectScripts(
		meta: URLMeta,
		handler: DomHandler,
		htmlcontext: HtmlContext,
		script: (src: string) => Element,
	): Element[];
	getWorkerInjectScripts?(
		meta: URLMeta,
		isModule: boolean,
		script: (src: string) => string,
	): string;
};

export type RamjetContext = {
	config: RamjetConfig;
	prefix: URL;
	interface: RamjetInterface;
	cookieJar: CookieJar;
	hooks?: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
	};
};

export type HtmlRewriterHooks = {
	pre: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
	};
	post: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
		props: {
			setRawHtml?: string;
		};
	};
};

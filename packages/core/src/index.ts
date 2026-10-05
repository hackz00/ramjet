import "./global.d";
import { atob } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { RamjetVersionInfo, RamjetConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: RamjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: RamjetConfig = {
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
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: false,
		scramitize: false,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: RamjetConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

declare const REWRITERWASM: string | undefined;

if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";

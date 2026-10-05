export const REGISTRY_URL = "https://registry.npmjs.org/";
export const RAMJET_PACKAGE_NAME = "@ramjet/core";

export const RAMJET_CONTROLLER_PACKAGE_NAME = "@ramjet/controller";
export const RAMJET_CONTROLLER_PINNED_MAJOR_VERSION = "0";

export const RAMJET_UTILS_PACKAGE_NAME = "@ramjet/utils";
export const RAMJET_UTILS_PINNED_MAJOR_VERSION = "0";

export const EPOXY_TRANSPORT_PACKAGE_NAME = "@mercuryworkshop/epoxy-transport";
export const EPOXY_TRANSPORT_PINNED_MAJOR_VERSION = "3";

export const LIBCURL_TRANSPORT_PACKAGE_NAME =
	"@mercuryworkshop/libcurl-transport";
export const LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION = "2";

export type TransportOptions = "epoxy" | "libcurl" | "bare";

export type PackageSource = "auto" | "local" | "registry";

export type BootstrapOptions = {
	transport: TransportOptions;
	swPath: string;

	wispPath: string;

	ramjetBundlePath: string;
	ramjetWasmPath: string;
	ramjetUtilsBundlePath: string;

	epoxyClientPath: string;
	libcurlClientPath: string;
	bareClientPath: string;
	ramjetControllerApiPath: string;
	ramjetControllerInjectPath: string;
	ramjetControllerSwPath: string;

	bootstrapApiPath: string;
	bootstrapInitPath: string;

	source?: PackageSource;

	localBaseUrl?: string;

	ramjetVersionPin?: string;
	ramjetControllerVersionPin?: string;
	ramjetUtilsVersionPin?: string;
	epoxyTransportVersionPin?: string;
	libcurlTransportVersionPin?: string;
	bareTransportVersionPin?: string;
};

export const defaultConfig: Partial<BootstrapOptions> = {
	transport: "libcurl",
	swPath: "/sw.js",
	wispPath: "/wisp/",

	epoxyClientPath: "/clients/epoxy-client.js",
	libcurlClientPath: "/clients/libcurl-client.js",
	bareClientPath: "/clients/bare-client.js",
	bootstrapInitPath: "/bootstrap-init.js",

	ramjetControllerApiPath: "/controller/controller.api.js",
	ramjetControllerInjectPath: "/controller/controller.inject.js",
	ramjetControllerSwPath: "/controller/controller.sw.js",
	ramjetBundlePath: "/scram/ramjet.js",
	ramjetWasmPath: "/scram/ramjet.wasm",
	ramjetUtilsBundlePath: "/scram/ramjet-utils.js",
};

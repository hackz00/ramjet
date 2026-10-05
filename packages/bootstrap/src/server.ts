import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import http from "http";
import { extract } from "tar";
import { Readable } from "stream";
import fs from "fs/promises";
import { join } from "node:path";
import {
	defaultConfig,
	EPOXY_TRANSPORT_PACKAGE_NAME,
	EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
	LIBCURL_TRANSPORT_PACKAGE_NAME,
	LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
	REGISTRY_URL,
	RAMJET_CONTROLLER_PACKAGE_NAME,
	RAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
	RAMJET_PACKAGE_NAME,
	RAMJET_UTILS_PACKAGE_NAME,
	RAMJET_UTILS_PINNED_MAJOR_VERSION,
	BootstrapOptions,
} from "./common";
import {
	packageSource,
	resolveLocalPackages,
	type LocalPackages,
} from "./local";

const bootstrapRoot = import.meta.dirname;

type ServerBootstrapOptions = BootstrapOptions & {
	downloadedFilesDir: string;
};

let config: ServerBootstrapOptions;

let local: LocalPackages | null = null;

function packageFile(
	kind: "controller" | "core" | "utils" | "libcurl",
	relative: string,
): string {
	const localRoot = local
		? kind === "libcurl"
			? local.transports.libcurl
			: local[kind]
		: undefined;
	if (localRoot) return join(localRoot, relative);
	const downloaded = {
		controller: "controller",
		core: "ramjet",
		utils: "ramjet-utils",
		libcurl: "libcurl-transport",
	}[kind];
	return `${config.downloadedFilesDir}${downloaded}/package/${relative}`;
}

async function sendFile(
	res: http.ServerResponse,
	filePath: string,
	contentType: string,
) {
	const data = await fs.readFile(filePath);
	res.writeHead(200, { "Content-Type": contentType });
	res.end(data);
}
const clientdata = await fs.readFile(
	join(bootstrapRoot, "bootstrap-client.js"),
);
function routeRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): boolean {
	if (!req.url) return false;

	if (req.url === config.swPath) {
		res.writeHead(200, { "Content-Type": "application/javascript" });
		res.end(`importScripts("${config.ramjetControllerSwPath}");
addEventListener("fetch", (e) => {
	if ($ramjetController.shouldRoute(e)) {
		e.respondWith($ramjetController.route(e));
	}
});
`);

		return true;
	} else if (req.url === config.bootstrapInitPath) {
		res.writeHead(200, { "Content-Type": "application/javascript" });
		res.end(`async function initBootstrap() {
	const { init } = await import("data:text/javascript;base64,${Buffer.from(clientdata).toString("base64")}");
	return init(${JSON.stringify(config)});
}`);

		return true;
	}

	const pathsToFiles = {
		[config.ramjetControllerApiPath]: packageFile(
			"controller",
			"dist/controller.api.js",
		),
		[config.ramjetControllerInjectPath]: packageFile(
			"controller",
			"dist/controller.inject.js",
		),
		[config.ramjetControllerSwPath]: packageFile(
			"controller",
			"dist/controller.sw.js",
		),
		[config.ramjetBundlePath]: packageFile("core", "dist/ramjet.js"),
		[config.ramjetWasmPath]: packageFile("core", "dist/ramjet.wasm"),
		[config.ramjetUtilsBundlePath]: packageFile(
			"utils",
			"dist/ramjet-utils.js",
		),
		[config.libcurlClientPath]: packageFile("libcurl", "dist/index.js"),
	};
	if (Object.hasOwn(pathsToFiles, req.url)) {
		const filePath = pathsToFiles[req.url as keyof typeof pathsToFiles];
		const contentType = req.url.endsWith(".wasm")
			? "application/wasm"
			: "application/javascript";
		void sendFile(res, filePath, contentType).catch(() => {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Runtime file unavailable");
		});
		return true;
	}

	return false;
}

function routeUpgrade(
	req: http.IncomingMessage,
	socket: any,
	head: Buffer,
): boolean {
	if (!req.url) return false;
	if (!req.url.startsWith("/wisp/")) return false;

	wisp.routeRequest(req, socket, head);
	return true;
}

export async function unpack(tarball: string, name: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
		throw new Error("Invalid package download name");
	const response = await fetch(tarball);
	if (!response.ok) {
		throw new Error(`Failed to download tarball: ${response.statusText}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);

	await fs.mkdir(config.downloadedFilesDir, { recursive: true });
	const file = join(config.downloadedFilesDir, `${name}.tgz`);
	await fs.writeFile(file, buffer);

	const packagedir = join(config.downloadedFilesDir, name);

	if (await fs.stat(packagedir).catch(() => false)) {
		await fs.rm(packagedir, { recursive: true, force: true });
	}
	await fs.mkdir(packagedir, { recursive: true });

	try {
		await extract({
			f: file,
			cwd: packagedir,
		});
		await fs.unlink(file);
	} catch (err) {
		console.error("Error extracting tarball:", err);
		await fs.unlink(file);
		throw err;
	}
}

async function getDownloadedPackageVersion(
	name: string,
): Promise<string | null> {
	const packagedir = `${config.downloadedFilesDir}${name}`;
	try {
		const pkgJson = JSON.parse(
			(await fs.readFile(
				`${packagedir}/package/package.json`,
				"utf-8",
			)) as unknown as string,
		);
		return pkgJson.version;
	} catch {
		return null;
	}
}

async function updateRamjet(controllerMeta: any) {
	const ramjetVersion = controllerMeta.devDependencies["@ramjet/core"];

	console.log(`Fetching ramjet version: ${ramjetVersion}`);
	const ramjetRes = await fetch(
		`${REGISTRY_URL}${RAMJET_PACKAGE_NAME}/${ramjetVersion}`,
	);
	const ramjetMeta = await ramjetRes.json();

	await unpack(ramjetMeta.dist.tarball, "ramjet");
	await unpack(controllerMeta.dist.tarball, "controller");
}

export async function findLatestVersionOfPackage(
	packageName: string,
	majorVersion: string,
): Promise<NodePackageMeta> {
	const packageRes = await fetch(`${REGISTRY_URL}${packageName}`);
	const packageMeta = await packageRes.json();
	const versions = Object.keys(packageMeta.versions).filter((v) =>
		v.startsWith(`${majorVersion}.`),
	);
	const sortedVersions = versions.sort((a, b) => {
		const aParts = a.split(".").map(Number);
		const bParts = b.split(".").map(Number);
		for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
			const aVal = aParts[i] || 0;
			const bVal = bParts[i] || 0;
			if (aVal !== bVal) return bVal - aVal;
		}
		return 0;
	});
	if (sortedVersions.length === 0) {
		throw new Error(
			`No versions found for package ${packageName} with major version ${majorVersion}`,
		);
	}
	const latestVersion = sortedVersions[0];

	const latestRes = await fetch(
		`${REGISTRY_URL}${packageName}/${latestVersion}`,
	);
	const latestMeta = await latestRes.json();
	return latestMeta;
}

type NodePackageMeta = {
	name: string;
	version: string;
	dist: {
		tarball: string;
	};
	dependencies: { [key: string]: string };
};

export async function bootstrap(
	cfg: Partial<ServerBootstrapOptions> = {},
): Promise<{
	routeRequest: typeof routeRequest;
	routeUpgrade: typeof routeUpgrade;
}> {
	config = {
		...defaultConfig,
		...cfg,
		downloadedFilesDir: join(bootstrapRoot, ".downloads") + "/",
	} as ServerBootstrapOptions;

	const source = packageSource(config.source);
	local =
		source === "registry"
			? null
			: resolveLocalPackages([process.cwd(), bootstrapRoot]);
	if (source === "local" && !local) {
		throw new Error(
			'Package source is "local", but @ramjet/core, @ramjet/controller and @ramjet/utils (with a built dist/) were not found in node_modules.',
		);
	}
	if (local) console.log(`Using the local Ramjet packages from ${local.core}`);

	if (config.transport !== "epoxy" && config.transport !== "libcurl") {
		throw new Error(`Unknown transport option: ${config.transport}`);
	}

	const transportInstalled = local?.transports[config.transport];
	if (transportInstalled) {
		console.log(
			`Using the installed ${config.transport} transport from ${transportInstalled}`,
		);
	} else if (config.transport === "epoxy") {
		const epoxyMeta = await findLatestVersionOfPackage(
			EPOXY_TRANSPORT_PACKAGE_NAME,
			EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
		);
		await unpack(epoxyMeta.dist.tarball, "epoxy-transport");
		console.log(`Using Epoxy Transport version: ${epoxyMeta.version}`);
	} else {
		const libcurlMeta = await findLatestVersionOfPackage(
			LIBCURL_TRANSPORT_PACKAGE_NAME,
			LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
		);
		await unpack(libcurlMeta.dist.tarball, "libcurl-transport");
		console.log(`Using libcurl Transport version: ${libcurlMeta.version}`);
	}

	if (local) {
		return { routeRequest, routeUpgrade };
	}

	const downloadedControllerVersion =
		await getDownloadedPackageVersion("controller");
	if (downloadedControllerVersion) {
		console.log(
			`Found downloaded Ramjet Controller version: ${downloadedControllerVersion}`,
		);
	}

	const controllerMeta = await findLatestVersionOfPackage(
		RAMJET_CONTROLLER_PACKAGE_NAME,
		RAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
	);

	if (downloadedControllerVersion === controllerMeta.version) {
		console.log(
			`Ramjet Controller is up to date (version: ${downloadedControllerVersion}), skipping download.`,
		);
	} else {
		await updateRamjet(controllerMeta);
		console.log(
			`Downloaded Ramjet Controller version: ${controllerMeta.version}`,
		);
	}

	const downloadedUtilsVersion =
		await getDownloadedPackageVersion("ramjet-utils");
	const utilsMeta = await findLatestVersionOfPackage(
		RAMJET_UTILS_PACKAGE_NAME,
		RAMJET_UTILS_PINNED_MAJOR_VERSION,
	);
	if (downloadedUtilsVersion === utilsMeta.version) {
		console.log(
			`Ramjet Utils is up to date (version: ${downloadedUtilsVersion}), skipping download.`,
		);
	} else {
		await unpack(utilsMeta.dist.tarball, "ramjet-utils");
		console.log(`Downloaded Ramjet Utils version: ${utilsMeta.version}`);
	}

	return {
		routeRequest,
		routeUpgrade,
	};
}

import { init, loadRest } from "./client";
import { loadScript, registerSw } from "./clientcommon";
import {
	BootstrapOptions,
	defaultConfig,
	RAMJET_CONTROLLER_PACKAGE_NAME,
	RAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
	RAMJET_PACKAGE_NAME,
	RAMJET_UTILS_PACKAGE_NAME,
	LIBCURL_TRANSPORT_PACKAGE_NAME,
	LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
	EPOXY_TRANSPORT_PACKAGE_NAME,
	EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
} from "./common";

const isSw = "ServiceWorkerGlobalScope" in globalThis;

const CDN_URL = "https://cdn.jsdelivr.net/npm/";
const DB_NAME = "ramjet-bootstrap";
const DB_VERSION = 1;
const STORE_NAME = "files";

type StaticBootstrapOptions = BootstrapOptions & {
	filePath?: string;
};

type FileEntry = {
	path: string;
	content: ArrayBuffer;
	contentType: string;
	version: string;
	timestamp: number;
};

type InitMessage = {
	config: BootstrapOptions;
};

type InitDoneMessage = {
	ready: boolean;
};

async function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);

		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: "path" });
				store.createIndex("version", "version", { unique: false });
				store.createIndex("timestamp", "timestamp", { unique: false });
			}
		};
	});
}

async function getFile(path: string): Promise<FileEntry | null> {
	if (!path) {
		throw new Error("Path is required for getFile");
	}
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readonly");
		const store = tx.objectStore(STORE_NAME);
		const request = store.get(path);

		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result || null);

		tx.onerror = () => reject(tx.error);
	});
}

async function saveFile(entry: FileEntry): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		const store = tx.objectStore(STORE_NAME);
		const request = store.put(entry);

		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();

		tx.onerror = () => reject(tx.error);
	});
}

async function findLatestVersion(
	packageName: string,
	majorVersion: string,
): Promise<string> {
	const response = await fetch(
		`https://data.jsdelivr.com/v1/packages/npm/${packageName}?a`,
	);
	if (!response.ok) {
		throw new Error(`Failed to fetch package info: ${response.statusText}`);
	}

	const data = await response.json();
	const versions = data.versions.filter((v: any) =>
		v.version.startsWith(`${majorVersion}.`),
	);

	if (versions.length === 0) {
		throw new Error(
			`No versions found for ${packageName} with major version ${majorVersion}`,
		);
	}

	return versions[0].version;
}

const LOCAL_DIRS: Record<string, string> = {
	[RAMJET_PACKAGE_NAME]: "core",
	[RAMJET_CONTROLLER_PACKAGE_NAME]: "controller",
	[RAMJET_UTILS_PACKAGE_NAME]: "utils",
};
const LOCAL_VERSION = "local";

let localBaseUrl: string | undefined;

async function downloadFile(
	packageName: string,
	version: string,
	filePath: string,
): Promise<ArrayBuffer> {
	const localDir =
		version === LOCAL_VERSION ? LOCAL_DIRS[packageName] : undefined;
	const url = localDir
		? `${localBaseUrl}${localDir}${filePath}`
		: `${CDN_URL}${packageName}@${version}${filePath}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.statusText}`);
	}

	return await response.arrayBuffer();
}

async function ensureFile(
	packageName: string,
	version: string,
	filePath: string,
	contentType: string,
	routePath: string,
): Promise<void> {
	const cached = await getFile(routePath);

	if (cached && cached.version === version && version !== LOCAL_VERSION) {
		console.log(`Using cached ${routePath} (${version})`);
		return;
	}

	console.log(`Downloading ${routePath} from ${packageName}@${version}...`);
	const content = await downloadFile(packageName, version, filePath);

	await saveFile({
		path: routePath,
		content,
		contentType,
		version,
		timestamp: Date.now(),
	});

	console.log(`Cached ${routePath} (${version})`);
}

if (isSw) {
	let config: BootstrapOptions;
	let ramjetControllerLoaded = false;

	addEventListener("message", (event) => {
		if (typeof event.data !== "object" || event.data === null) return;

		if (event.data.type === "init-bootstrap") {
			initBootstrapSw(event.data.message);
		}

		if (event.data.type === "SKIP_WAITING") {
			(self as any).skipWaiting();
		}
	});

	addEventListener("fetch", (event: any) => {
		const url = new URL(event.request.url);
		const path = url.pathname;

		if (!config || !path) {
			return;
		}

		event.respondWith(
			(async () => {
				if (ramjetControllerLoaded && (self as any).$ramjetController) {
					const controller = (self as any).$ramjetController;
					if (controller.shouldRoute(event)) {
						return controller.route(event);
					}
				}

				const cached = await getFile(path);
				if (cached) {
					return new Response(cached.content, {
						headers: {
							"Content-Type": cached.contentType,
							"Cache-Control": "public, max-age=31536000",
						},
					});
				}

				return fetch(event.request);
			})(),
		);
	});

	async function initBootstrapSw(opts: InitMessage) {
		config = { ...defaultConfig, ...opts.config } as BootstrapOptions;
		localBaseUrl = config.localBaseUrl;

		try {
			let controllerVersion: string;
			let ramjetVersion: string;
			if (config.localBaseUrl) {
				controllerVersion = LOCAL_VERSION;
				ramjetVersion = LOCAL_VERSION;
			} else {
				controllerVersion = await findLatestVersion(
					RAMJET_CONTROLLER_PACKAGE_NAME,
					config.ramjetControllerVersionPin ||
						RAMJET_CONTROLLER_PINNED_MAJOR_VERSION,
				);

				console.log(controllerVersion);

				const controllerPkgUrl = `${CDN_URL}${RAMJET_CONTROLLER_PACKAGE_NAME}@${controllerVersion}/package.json`;
				const controllerPkgResponse = await fetch(controllerPkgUrl);
				const controllerPkg = await controllerPkgResponse.json();

				console.log(controllerPkg);
				ramjetVersion = controllerPkg.dependencies[RAMJET_PACKAGE_NAME].replace(
					/^[\^~]/,
					"",
				);
			}

			await ensureFile(
				RAMJET_PACKAGE_NAME,
				ramjetVersion,
				"/dist/ramjet.js",
				"application/javascript",
				config.ramjetBundlePath,
			);

			await ensureFile(
				RAMJET_PACKAGE_NAME,
				ramjetVersion,
				"/dist/ramjet.wasm",
				"application/wasm",
				config.ramjetWasmPath,
			);

			await ensureFile(
				RAMJET_CONTROLLER_PACKAGE_NAME,
				controllerVersion,
				"/dist/controller.api.js",
				"application/javascript",
				config.ramjetControllerApiPath,
			);

			await ensureFile(
				RAMJET_CONTROLLER_PACKAGE_NAME,
				controllerVersion,
				"/dist/controller.inject.js",
				"application/javascript",
				config.ramjetControllerInjectPath,
			);

			await ensureFile(
				RAMJET_CONTROLLER_PACKAGE_NAME,
				controllerVersion,
				"/dist/controller.sw.js",
				"application/javascript",
				config.ramjetControllerSwPath,
			);

			if (config.transport === "libcurl") {
				const libcurlVersion = await findLatestVersion(
					LIBCURL_TRANSPORT_PACKAGE_NAME,
					config.libcurlTransportVersionPin ||
						LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION,
				);

				await ensureFile(
					LIBCURL_TRANSPORT_PACKAGE_NAME,
					libcurlVersion,
					"/dist/index.js",
					"application/javascript",
					config.libcurlClientPath,
				);
			} else if (config.transport === "epoxy") {
				const epoxyVersion = await findLatestVersion(
					EPOXY_TRANSPORT_PACKAGE_NAME,
					config.epoxyTransportVersionPin ||
						EPOXY_TRANSPORT_PINNED_MAJOR_VERSION,
				);

				await ensureFile(
					EPOXY_TRANSPORT_PACKAGE_NAME,
					epoxyVersion,
					"/dist/index.js",
					"application/javascript",
					config.epoxyClientPath,
				);
			}

			console.log("Bootstrap initialization complete");

			try {
				const cachedController = await getFile(config.ramjetControllerSwPath);
				if (cachedController) {
					const decoder = new TextDecoder();
					const scriptContent = decoder.decode(cachedController.content);

					(0, eval)(scriptContent);

					ramjetControllerLoaded = true;
					console.log("Ramjet controller loaded");
				} else {
					console.error("Ramjet controller not found in cache");
				}
			} catch (error) {
				console.error("Failed to load ramjet controller:", error);
			}

			(self as any).clients.matchAll().then((clients: any[]) => {
				clients.forEach((client: any) => {
					client.postMessage({
						type: "init-bootstrap-done",
						message: { ready: true } as InitDoneMessage,
					});
				});
			});
		} catch (error) {
			console.error("Bootstrap initialization failed:", error);
			throw error;
		}
	}
} else {
	const currentScript = document.currentScript as HTMLScriptElement | null;
	async function initBootstrap(opts: StaticBootstrapOptions) {
		let filePath = opts.filePath;
		if (!filePath) {
			if (currentScript && currentScript.src) {
				filePath = currentScript.src;
			}
			if (!filePath) {
				throw new Error(
					"Could not determine bootstrap file path and none was provided!",
				);
			}
		}

		const sw = await registerSw(filePath);

		const fullConfig = { ...defaultConfig, ...opts } as BootstrapOptions;

		const message: InitMessage = {
			config: fullConfig,
		};
		sw.postMessage({
			type: "init-bootstrap",
			message,
		});

		const initDone = await new Promise<InitDoneMessage>((resolve) => {
			const onMessage = (event: MessageEvent) => {
				if (typeof event.data !== "object" || event.data === null) return;
				if (event.data.type === "init-bootstrap-done") {
					navigator.serviceWorker.removeEventListener("message", onMessage);
					resolve(event.data.message);
				}
			};
			navigator.serviceWorker.addEventListener("message", onMessage);
		});
		console.log(initDone);

		return await loadRest(sw, fullConfig);
	}

	(window as any).initBootstrap = initBootstrap;
}

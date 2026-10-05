import express from "express";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { buildFixtures } from "./fixtures.ts";
import {
	startAssistedServer,
	type AssistedServer,
} from "../../assisted-server/src/server.ts";
import type { NetProfile } from "./profiles.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PORT = 4600;
export const WISP_PORT = 4601;
export const ASSISTED_PORT = 4690;

export const ASSET_PORTS = [4602, 4603, 4604, 4605, 4606, 4607];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const requestLog: string[] = [];

export const conditionalLog: string[] = [];

export const originStats = { connections: 0, tlsSessions: 0, requests: 0 };

export interface FixtureOptions {
	tls?: boolean;

	sharedLink?: boolean;
}

class SharedLink {
	private freeAt = 0;
	private readonly bytesPerMs: number;
	constructor(bytesPerMs: number) {
		this.bytesPerMs = bytesPerMs;
	}
	async take(bytes: number): Promise<void> {
		const now = performance.now();
		const start = Math.max(now, this.freeAt);
		this.freeAt = start + bytes / this.bytesPerMs;
		const wait = this.freeAt - now;
		if (wait > 2) await sleep(wait);
	}
}

let cachedCert: { key: string; cert: string } | undefined;
function selfSignedCert(): { key: string; cert: string } {
	if (cachedCert) return cachedCert;
	const dir = mkdtempSync(path.join(tmpdir(), "ramjet-bench-cert-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				path.join(dir, "k.pem"),
				"-out",
				path.join(dir, "c.pem"),
				"-days",
				"2",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost",
			],
			{ stdio: "ignore" },
		);
		cachedCert = {
			key: readFileSync(path.join(dir, "k.pem"), "utf8"),
			cert: readFileSync(path.join(dir, "c.pem"), "utf8"),
		};
		return cachedCert;
	} catch (error) {
		throw new Error(
			`the TLS fixtures need the openssl CLI to make a self-signed certificate: ${(error as Error).message}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function startFixtureServer(
	profile: NetProfile,
	options: FixtureOptions = {},
): Promise<http.Server> {
	const fixtures = buildFixtures(options.tls ? "https" : "http");
	const bytesPerMs = (profile.mbps * 1e6) / 8 / 1000;
	const link = options.sharedLink ? new SharedLink(bytesPerMs) : null;

	const listener: http.RequestListener = async (req, res) => {
		const url = req.url ?? "/";
		requestLog.push(url);
		originStats.requests++;
		const asset = fixtures[url] ?? fixtures[url.split("?")[0]];
		await sleep(profile.rttMs);
		if (!asset) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
			return;
		}
		const body =
			typeof asset.body === "string" ? Buffer.from(asset.body) : asset.body;
		if (asset.validators) {
			const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
			const sent = req.headers["if-none-match"];
			if (sent || req.headers["if-modified-since"]) {
				const same = sent === etag;
				conditionalLog.push(`${same ? 304 : 200} ${url.split("?")[0]}`);
				if (same) {
					res.writeHead(304, { ETag: etag, ...(asset.headers ?? {}) });
					res.end();
					return;
				}
			}
			asset.headers = { ...(asset.headers ?? {}), ETag: etag };
		}
		res.writeHead(200, {
			"Content-Type": asset.type,
			"Content-Length": String(body.length),
			...(asset.headers ?? {}),
		});

		const CHUNK = 32 * 1024;
		const startedAt = performance.now();
		let sent = 0;
		for (let off = 0; off < body.length; off += CHUNK) {
			const chunk = body.subarray(off, off + CHUNK);
			if (link) await link.take(chunk.length);
			if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
			sent += chunk.length;
			if (!link) {
				const wait = startedAt + sent / bytesPerMs - performance.now();
				if (wait > 2) await sleep(wait);
			}
		}
		res.end();
	};

	const listen = (port: number): Promise<http.Server> =>
		new Promise((resolve, reject) => {
			if (!options.tls) {
				const s = http.createServer(listener);
				s.on("connection", () => originStats.connections++);
				s.once("error", reject);
				s.listen(port, () => resolve(s));
				return;
			}
			const { key, cert } = selfSignedCert();
			const secure = http2.createSecureServer(
				{ key, cert, allowHTTP1: true },
				listener as never,
			);
			secure.on("secureConnection", () => originStats.tlsSessions++);
			const front = net.createServer({ pauseOnConnect: true }, (socket) => {
				originStats.connections++;
				setTimeout(() => {
					secure.emit("connection", socket);
					socket.resume();
				}, 2 * profile.rttMs);
			});
			front.once("error", reject);
			front.listen(port, () => resolve(front as unknown as http.Server));
		});

	const server = await listen(FIXTURE_PORT);
	const assetServers = await Promise.all(ASSET_PORTS.map(listen));
	const close = server.close.bind(server);
	server.close = ((cb?: (err?: Error) => void) => {
		for (const s of assetServers) s.close();
		return close(cb);
	}) as typeof server.close;
	return server;
}

export function startAssistedForBench(
	options: { insecureTls?: boolean } = {},
): Promise<AssistedServer> {
	return startAssistedServer({
		port: ASSISTED_PORT,
		guard: { allowPrivate: true },
		insecureTls: options.insecureTls,
	});
}

export async function startWispServer(): Promise<http.Server> {
	const srv = http.createServer((_, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("wisp");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);
	srv.on("upgrade", (req, socket, head) =>
		wisp.routeRequest(req, socket, head),
	);
	await new Promise<void>((r) => srv.listen(WISP_PORT, r));
	return srv;
}

export interface DistDirs {
	core: string;

	controller: string;
}

export async function startHarnessServer(
	dist: DistDirs,
	port: number,
	options: { longCache?: boolean } = {},
): Promise<http.Server> {
	const app = express();

	const staticOpts = options.longCache
		? {
				etag: true,
				lastModified: true,
				maxAge: 31536000 * 1000,
				immutable: true,
			}
		: { etag: true, lastModified: true, maxAge: 0 };

	app.use("/ramjet", express.static(dist.core, staticOpts));
	app.use("/" + "scram" + "jet", express.static(dist.core, staticOpts));
	app.use("/controller", express.static(dist.controller, staticOpts));
	const libcurlDist = path.resolve(
		__dirname,
		"../node_modules/@mercuryworkshop/libcurl-transport/dist",
	);
	app.use("/libcurl", express.static(libcurlDist, staticOpts));
	app.use(
		"/assisted",
		express.static(
			path.resolve(__dirname, "../../transport-assisted/dist"),
			staticOpts,
		),
	);
	app.use(express.static(path.resolve(__dirname, "../harness"), staticOpts));
	const server = http.createServer(app);
	await new Promise<void>((r) => server.listen(port, r));
	return server;
}

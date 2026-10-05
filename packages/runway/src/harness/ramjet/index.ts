import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { startAssistedServer } from "../../../../assisted-server/src/server.ts";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const packageRoot = path.resolve(__dirname, "../../..");

export const PORT = 4500;
export const WISP_PORT = 4501;
export const ASSISTED_PORT = 4510;

const TRANSPORT =
	process.env.RUNWAY_TRANSPORT === "assisted" ? "assisted" : "libcurl";

export async function startHarness() {
	const app = express();

	app.use(
		"/ramjet",
		express.static(path.join(packageRoot, "node_modules/@ramjet/core/dist")),
	);

	app.use(
		"/controller",
		express.static(
			path.join(packageRoot, "node_modules/@ramjet/controller/dist"),
		),
	);

	app.use(
		"/libcurl",
		express.static(
			path.join(
				packageRoot,
				"node_modules/@mercuryworkshop/libcurl-transport/dist",
			),
		),
	);

	app.use(
		"/assisted",
		express.static(path.resolve(packageRoot, "../transport-assisted/dist")),
	);
	app.get("/transport-config.js", (_req, res) => {
		res
			.type("js")
			.send(`window.__runwayTransport=${JSON.stringify(TRANSPORT)};`);
	});

	app.use(express.static(path.join(__dirname, "public")));

	app.listen(PORT, () => {
		console.log(`    Harness server listening on port ${PORT}`);
	});

	const wispServer = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("wisp server");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);

	wispServer.on("upgrade", (req, socket, head) => {
		wisp.routeRequest(req, socket, head);
	});

	if (TRANSPORT === "assisted") {
		await startAssistedServer({
			port: ASSISTED_PORT,
			guard: { allowPrivate: true },
		});
		console.log(
			`    Assisted transport server listening on port ${ASSISTED_PORT}`,
		);
	}

	wispServer.listen(WISP_PORT, () => {
		console.log(`    Wisp server listening on port ${WISP_PORT}`);
	});
}

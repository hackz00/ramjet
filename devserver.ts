import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import { execSync } from "node:child_process";
import http from "node:http";
import chalk from "chalk";
import { createServer } from "vite";
//@ts-expect-error no typedefs
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import {
	normalizeWebsocketUrl,
	warnOnUrlEscape,
	runRspack,
	black,
	printBanner,
} from "./devlib.ts";
import rspackConfig from "./rspack.config.ts";
import { startAssistedServer } from "./packages/assisted-server/src/server.ts";

const image = await fs.readFile("./assets/ramjet-mini-noalpha.display.png");

const commit = execSync("git rev-parse --short HEAD", {
	encoding: "utf-8",
}).replace(/\r?\n|\r/g, "");
const branch = execSync("git rev-parse --abbrev-ref HEAD", {
	encoding: "utf-8",
}).replace(/\r?\n|\r/g, "");
const packagejson = JSON.parse(await fs.readFile("./package.json", "utf-8"));
const version = packagejson.version;

const DEMO_PORT = process.env.DEMO_PORT || 4141;
const WISP_PORT = process.env.WISP_PORT || 4142;
const ASSISTED_PORT = process.env.ASSISTED_PORT || 4143;

if (process.env.VITE_WISP_URL) {
	process.env.VITE_WISP_URL = normalizeWebsocketUrl(process.env.VITE_WISP_URL);
} else {
	process.env.VITE_WISP_URL = `ws://localhost:${WISP_PORT}/`;
}

process.env.VITE_ASSISTED_URL ??= `ws://localhost:${ASSISTED_PORT}/assisted`;
await startAssistedServer({
	port: Number(ASSISTED_PORT),
	guard: { allowPrivate: true },
});

const wispserver = http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("wisp server js rewrite");
});
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;

wispserver.on("upgrade", (req, socket, head) => {
	wisp.routeRequest(req, socket, head);
});

wispserver.listen(Number(WISP_PORT), "127.0.0.1");

const server = await createServer({
	configFile: "./packages/demo/vite.config.ts",
	root: "./packages/demo",
	server: {
		port: Number(DEMO_PORT),
		strictPort: true,
	},
});

warnOnUrlEscape(server);

await server.listen();

const accent = (text: string) => chalk.hex("#f1855bff").bold(text);
const highlight = (text: string) => chalk.hex("#fdd76cff").bold(text);
const urlColor = (text: string) => chalk.hex("#64DFDF").underline(text);
const note = (text: string) => chalk.hex("#CDB4DB")(text);
const connector = chalk.hex("#8D99AE").dim("@");

const lines = [
	black()(`${highlight("RAMJET DEV SERVER")}`),
	black()(
		`${accent("demo")} ${connector} ${urlColor(
			`http://localhost:${DEMO_PORT}/`,
		)}`,
	),
	black()(
		`${accent("wisp")} ${connector} ${urlColor(
			process.env.VITE_WISP_URL ?? "",
		)}`,
	),
	black()(chalk.dim(`[${branch}] ${commit} ramjet/${version}`)),
];

runRspack(rspackConfig);

printBanner(image, lines);

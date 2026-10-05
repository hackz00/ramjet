import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarBinary = process.platform === "win32"
	? path.join(process.env.SystemRoot, "System32", "tar.exe")
	: "tar";
const releaseDir = path.resolve(
	process.argv[2] ?? path.join(root, "release-artifacts"),
);
const execFileAsync = promisify(execFile);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`,
	);
};

const npmCli = [
	path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
	path.join(
		path.dirname(process.execPath),
		"../lib/node_modules/npm/bin/npm-cli.js",
	),
].find(existsSync);
const npm = (args, cwd) => {
	try {
		return execFileSync(process.execPath, [npmCli, ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw new Error(
			`npm ${args[0]} failed: ${String(error.stderr ?? error.message)
				.trim()
				.split(/\r?\n/)
				.slice(0, 6)
				.join(" | ")}`,
		);
	}
};
const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
const until = async (fn, ms = 20000) => {
	const end = Date.now() + ms;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {}
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 200));
	}
};

const work = mkdtempSync(path.join(os.tmpdir(), "ramjet-verify-"));
const children = [];
try {
	const sums = readFileSync(path.join(releaseDir, "SHA256SUMS"), "utf8")
		.trim()
		.split("\n")
		.map((l) => l.split(/\s+/));
	const bad = sums.filter(
		([sha, name]) =>
			createHash("sha256")
				.update(readFileSync(path.join(releaseDir, name)))
				.digest("hex") !== sha,
	);
	check(
		"SHA256SUMS matches every archive",
		bad.length === 0 && sums.length > 0,
		`${sums.length} files`,
	);

	const tarballs = readdirSync(releaseDir)
		.filter((f) => f.endsWith(".tgz"))
		.map((f) => path.join(releaseDir, f));
	const project = path.join(work, "project");
	mkdirSync(project);
	writeFileSync(
		path.join(project, "package.json"),
		JSON.stringify({
			name: "fresh-install",
			version: "1.0.0",
			type: "module",
			private: true,
		}),
	);
	npm(
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			...tarballs,
			"@mercuryworkshop/libcurl-transport@2.0.5",
			"express@4",
			"typescript@5.9.3",
		],
		project,
	);
	const installed = (name) =>
		existsSync(
			path.join(project, "node_modules", ...name.split("/"), "package.json"),
		);
	const names = [
		"@ramjet/core",
		"@ramjet/controller",
		"@ramjet/utils",
		"@ramjet/bootstrap",
		"@ramjet/transport-assisted",
		"@ramjet/assisted-server",
		"create-ramjet-app",
	];
	check(
		"all packages install from the tarballs",
		names.every(installed),
		names.filter((n) => !installed(n)).join(", "),
	);

	const browserArchive = readdirSync(releaseDir).find((file) =>
		/^ramjet-browser-.*\.tar\.gz$/.test(file),
	);
	if (!browserArchive) throw new Error("Missing browser build archive");
	const browserDir = path.join(work, "browser");
	mkdirSync(browserDir);
	execFileSync(tarBinary, [
		"-xzf",
		path.join(releaseDir, browserArchive),
		"-C",
		browserDir,
	]);
	const browserFiles = [
		["ramjet/ramjet.js", "core", "ramjet.js"],
		["ramjet/ramjet.wasm", "core", "ramjet.wasm"],
		["ramjet/ramjet-utils.js", "utils", "ramjet-utils.js"],
		["controller/controller.api.js", "controller", "controller.api.js"],
		["controller/controller.inject.js", "controller", "controller.inject.js"],
		["controller/controller.sw.js", "controller", "controller.sw.js"],
		[
			"transport/assisted-transport.js",
			"transport-assisted",
			"assisted-transport.js",
		],
	];
	check(
		"browser build matches the installed runtime packages",
		browserFiles.every(([file, name, artifact]) =>
			readFileSync(path.join(browserDir, file)).equals(
				readFileSync(
					path.join(project, "node_modules/@ramjet", name, "dist", artifact),
				),
			),
		),
	);

	const missingTypes = [];
	for (const name of [
		"core",
		"controller",
		"utils",
		"bootstrap",
		"transport-assisted",
	]) {
		const typeRoot = path.join(
			project,
			"node_modules/@ramjet",
			name,
			"dist/types",
		);
		for (const file of readdirSync(typeRoot, { recursive: true }).filter(
			(file) => file.endsWith(".d.ts"),
		)) {
			const full = path.join(typeRoot, file);
			for (const match of readFileSync(full, "utf8").matchAll(
				/(?:from\s*|import\s*\(|import\s*)["']([^"']+)["']/g,
			)) {
				const spec = match[1];
				if (spec.startsWith(".")) {
					const target = path.resolve(path.dirname(full), spec);
					if (
						![
							target,
							target + ".ts",
							target + ".d.ts",
							target.replace(/\.(?:ts|js)$/, ".d.ts"),
							path.join(target, "index.d.ts"),
						].some(existsSync)
					)
						missingTypes.push(name + ": " + file + " -> " + spec);
				} else if (spec.startsWith("@ramjet/") && !installed(spec))
					missingTypes.push(spec);
			}
		}
	}
	check(
		"published declarations contain no missing local or private Ramjet imports",
		missingTypes.length === 0,
		missingTypes.join(", "),
	);

	writeFileSync(
		path.join(project, "consumer.ts"),
		`
		import { RamjetFetchHandler } from "@ramjet/core";
		import { Controller } from "@ramjet/controller";
		import * as utils from "@ramjet/utils";
		import { bootstrap } from "@ramjet/bootstrap";
		import { AssistedTransport } from "@ramjet/transport-assisted";
		const api = [RamjetFetchHandler, Controller, utils, bootstrap, AssistedTransport];
		void api;
	`,
	);
	const tsc = path.join(project, "node_modules/typescript/bin/tsc");
	execFileSync(
		process.execPath,
		[
			tsc,
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"--target",
			"ES2022",
			"--module",
			"ESNext",
			"--moduleResolution",
			"Bundler",
			"--lib",
			"ES2022,DOM,DOM.Iterable",
			"consumer.ts",
		],
		{ cwd: project, encoding: "utf8" },
	);
	check(
		"installed package declarations compile in a fresh TypeScript consumer",
		true,
	);

	const origin = http
		.createServer((req, res) => res.end("hello from the origin"))
		.listen(0);
	const originPort = origin.address().port;
	const serverPort = await freePort();
	const server = spawn(
		process.execPath,
		[
			path.join(project, "node_modules/@ramjet/assisted-server/dist/cli.mjs"),
			"--port",
			String(serverPort),
			"--allow-private",
		],
		{ cwd: project, stdio: "ignore" },
	);
	children.push(server);
	await until(
		async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).status === 426,
	);
	check(
		"the installed assisted server starts and answers plain HTTP with 426",
		true,
	);
	const script = `
		import { AssistedTransport } from "@ramjet/transport-assisted";
		const t = new AssistedTransport({ url: "ws://127.0.0.1:${serverPort}/assisted" });
		await t.init();
		const r = await t.request(new URL("http://127.0.0.1:${originPort}/"), "GET", null, [], undefined);
		console.log(r.status, await new Response(r.body).text());
		t.close();`;
	let echo;
	try {
		echo = (
			await execFileAsync(
				process.execPath,
				["--input-type=module", "-e", script],
				{ cwd: project, encoding: "utf8", timeout: 30_000 },
			)
		).stdout.trim();
	} catch (error) {
		echo =
			"error: " +
			String(error.stderr ?? error.message)
				.trim()
				.split(/\r?\n/)
				.filter((l) => !/^\s+at /.test(l))
				.slice(0, 6)
				.join(" | ");
	}
	check(
		"a request through the installed transport and server reaches the origin",
		echo === "200 hello from the origin",
		echo,
	);
	origin.close();

	const boot = `
		import { bootstrap } from "@ramjet/bootstrap";
		const b = await bootstrap({ source: "local", transport: "libcurl" });
		const get = async (url) => { let body = Buffer.alloc(0), status = 0; b.routeRequest({ url }, { writeHead: (s) => (status = s), end: (d) => (body = Buffer.from(d ?? "")) }); await new Promise((r) => setTimeout(r, 300)); return status + ":" + body.length; };
		console.log(JSON.stringify([await get("/controller/controller.api.js"), await get("/scram/ramjet.js"), await get("/scram/ramjet.wasm"), await get("/scram/ramjet-utils.js")]));
		process.exit(0);`;
	const served = JSON.parse(
		execFileSync(
			process.execPath,
			["--no-warnings", "--input-type=module", "-e", boot],
			{ cwd: project, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.pop(),
	);
	check(
		"bootstrap serves controller, runtime, wasm and utils from the installed packages",
		served.every((s) => s.startsWith("200:") && Number(s.split(":")[1]) > 1000),
		served.join(" "),
	);

	execFileSync(
		process.execPath,
		[
			path.join(project, "node_modules/create-ramjet-app/dist/index.js"),
			"app",
			"--default",
			"--source",
			"registry",
		],
		{ cwd: work, stdio: "ignore" },
	);
	const app = path.join(work, "app");
	check(
		"create-ramjet-app scaffolds an app",
		existsSync(path.join(app, "server.js")) &&
			existsSync(path.join(app, "public/index.html")),
	);
	npm(
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			...tarballs,
			"@mercuryworkshop/libcurl-transport@2.0.5",
			"express@4",
		],
		app,
	);
	const appServer = spawn(process.execPath, ["server.js"], {
		cwd: app,
		stdio: "ignore",
		env: { ...process.env, RAMJET_BOOTSTRAP_SOURCE: "local" },
	});
	children.push(appServer);
	const page = await until(async () => {
		const r = await fetch("http://127.0.0.1:3030/");
		return r.status === 200 ? r : null;
	});
	check("the scaffolded app serves its page", page.status === 200);
	const wasm = await fetch("http://127.0.0.1:3030/scram/ramjet.wasm");
	const wasmBytes = (await wasm.arrayBuffer()).byteLength;
	check(
		"the scaffolded app serves the rewriter wasm",
		wasm.status === 200 &&
			wasm.headers.get("content-type") === "application/wasm" &&
			wasmBytes > 500_000,
		`${wasmBytes} bytes`,
	);
} catch (error) {
	check(
		"verification ran to the end",
		false,
		String(error?.message ?? error).split("\n")[0],
	);
} finally {
	for (const child of children) child.kill();
	rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exit(failed.length ? 1 : 0);

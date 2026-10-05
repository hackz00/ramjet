import { chromium } from "playwright";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { INIT_SCRIPT } from "./metrics.ts";
import { PROFILES } from "./profiles.ts";
import {
	FIXTURE_PORT,
	conditionalLog,
	requestLog,
	startAssistedForBench,
	startFixtureServer,
	startHarnessServer,
	startWispServer,
} from "./servers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const dist = {
	core: path.join(ROOT, "packages/core/dist"),
	controller: path.join(ROOT, "packages/controller/dist"),
};

const fixtureServer = await startFixtureServer(PROFILES.fast);
const wisp = await startWispServer();
const assistedServer = await startAssistedForBench();
const harness = await startHarnessServer(dist, 4650);
const userDataDir = mkdtempSync(path.join(tmpdir(), "ramjet-verify-"));

async function session(
	url: string,
	assisted = false,
): Promise<{ bundleReady: boolean; revalReady: boolean; requests: string[] }> {
	const context = await chromium.launchPersistentContext(userDataDir, {
		headless: true,
		serviceWorkers: "allow",
	});
	try {
		await context.addInitScript(INIT_SCRIPT);
		const page = await context.newPage();
		if (process.env.VC_DEBUG) {
			page.on("console", (m) =>
				console.log("  [console]", m.type(), m.text().slice(0, 300)),
			);
			page.on("pageerror", (e) =>
				console.log("  [pageerror]", (e.stack || String(e)).slice(0, 900)),
			);
		}
		await page.goto(
			`http://localhost:4650/${assisted ? "?transport=assisted" : ""}`,
		);
		await page.waitForFunction(
			() => (window as any).__benchReady || (window as any).__benchError,
		);
		const before = requestLog.length;
		await page.evaluate((u) => (window as any).__benchGo(u), url);
		await page.waitForTimeout(1500);
		const child = page
			.frames()
			.find((f) => f.parentFrame() === page.mainFrame())!;
		const bundleReady = await child.evaluate(
			() => typeof (window as any).__bundleReady === "number",
		);
		const revalReady = await child.evaluate(
			() => typeof (window as any).__revalReady === "number",
		);
		return { bundleReady, revalReady, requests: requestLog.slice(before) };
	} finally {
		await context.close();
	}
}

let failed = false;
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
	if (!ok) failed = true;
};

try {
	const url = `http://localhost:${FIXTURE_PORT}/spa.html`;
	const first = await session(url);
	check(first.bundleReady, "session 1: the SPA bundle ran");
	check(
		first.requests.some((r) => r.startsWith("/spa-bundle.js")),
		"session 1: bundle fetched from origin",
	);

	const second = await session(url);
	check(
		second.bundleReady,
		"session 2: the cached bundle ran under a new proxy prefix",
	);
	check(
		!second.requests.some((r) => r.startsWith("/spa-bundle.js")),
		"session 2: bundle NOT fetched from origin",
	);
	check(
		!second.requests.some((r) => r.startsWith("/vendor-")),
		"session 2: vendor scripts NOT fetched from origin",
	);
	check(
		second.requests.some((r) => r.startsWith("/spa.html")),
		"session 2: the document itself is still fetched (never cached)",
	);

	for (const assisted of [true, false]) {
		const label = assisted
			? "revalidation (assisted)"
			: "no revalidation (libcurl)";
		const reval = `http://localhost:${FIXTURE_PORT}/reval.html`;
		const r1 = await session(reval, assisted);
		check(
			r1.requests.some((r) => r.startsWith("/reval.js")),
			`${label}: session 1 fetched the script`,
		);
		await new Promise((r) => setTimeout(r, 1500));
		const before = conditionalLog.length;
		const r2 = await session(reval, assisted);
		const conditional = conditionalLog.slice(before);
		check(r2.revalReady, `${label}: the script ran on the second visit`);
		if (assisted) {
			check(
				conditional.includes("304 /reval.js"),
				`${label}: stale entry revalidated with a conditional request answered 304 (${conditional.join(", ") || "none"})`,
			);
		} else {
			check(
				conditional.length === 0,
				`${label}: no conditional request was sent`,
			);
		}
		check(
			r2.requests.filter((r) => r.startsWith("/reval.js")).length === 1,
			`${label}: exactly one origin request for the script`,
		);
	}
	console.log(
		`origin requests: session 1 = ${first.requests.length}, session 2 = ${second.requests.length}`,
	);
} finally {
	fixtureServer.close();
	wisp.close();
	await assistedServer.close();
	harness.close();
	rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT_SCRIPT, collectFrame } from "./metrics.ts";
import { PROFILES } from "./profiles.ts";
import {
	FIXTURE_PORT,
	startFixtureServer,
	startHarnessServer,
	startWispServer,
} from "./servers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const arg = (k: string, d: string) => {
	const i = process.argv.indexOf(k);
	return i >= 0 ? process.argv[i + 1] : d;
};
const distName = arg("--dist", "current");
const fixture = arg("--fixture", "article");
const mode = arg("--mode", "cold");
const dist =
	distName === "baseline"
		? {
				core: path.join(ROOT, "bench/baseline-dist/core"),
				controller: path.join(ROOT, "bench/baseline-dist/controller"),
			}
		: {
				core: path.join(ROOT, "packages/core/dist"),
				controller: path.join(ROOT, "packages/controller/dist"),
			};

const fixtureServer = await startFixtureServer(
	PROFILES[arg("--profile", "typical")],
);
const wisp = await startWispServer();
const harness = await startHarnessServer(dist, 4630);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: "allow" });
await context.addInitScript(INIT_SCRIPT);
const page = await context.newPage();
await page.goto("http://localhost:4630/");
await page.waitForFunction(
	() => (window as any).__benchReady || (window as any).__benchError,
);
const url = `http://localhost:${FIXTURE_PORT}/${fixture}.html`;
if (mode === "warm") {
	await page.evaluate((u) => (window as any).__benchGo(u), url);
	await page.waitForTimeout(800);
}
const nav = (await page.evaluate((u) => (window as any).__benchGo(u), url)) as {
	t0: number;
	tLoad: number;
};
await page.waitForTimeout(800);
const child = page.frames().find((f) => f.parentFrame() === page.mainFrame())!;
const fm = await collectFrame(child);
const rows = await child.evaluate(() => {
	const o = performance.timeOrigin;
	const nav = performance.getEntriesByType("navigation")[0] as any;
	const res = performance.getEntriesByType("resource") as any[];
	return {
		origin: o,
		nav: nav && {
			start: nav.startTime,
			resStart: nav.responseStart,
			resEnd: nav.responseEnd,
			dcl: nav.domContentLoadedEventEnd,
		},
		res: res.map((e) => ({
			name: e.name
				.replace(/^https?:\/\/[^/]+/, "")
				.replace(/~\/sj\/[^/]+\/[^/]+\//, "")
				.slice(0, 60),
			s: e.startTime,
			rs: e.responseStart,
			re: e.responseEnd,
			size: e.encodedBodySize,
		})),
	};
});
const rel = (t: number) => (rows.origin + t - nav.t0).toFixed(0).padStart(5);
console.log(
	`${distName} ${fixture} ${mode}: fcp=${(fm.fcpAbs - nav.t0).toFixed(0)}ms load=${(nav.tLoad - nav.t0).toFixed(0)}ms`,
);
if (rows.nav)
	console.log(
		`document: responseStart=${rel(rows.nav.resStart)} responseEnd=${rel(rows.nav.resEnd)} DCL=${rel(rows.nav.dcl)}`,
	);
console.log("   start  respStart  respEnd   size  resource");
for (const r of rows.res.sort((a, b) => a.s - b.s))
	console.log(
		`${rel(r.s)} ${rel(r.rs)}    ${rel(r.re)}  ${String(r.size).padStart(7)}  ${r.name}`,
	);
await browser.close();
fixtureServer.close();
wisp.close();
harness.close();
process.exit(0);

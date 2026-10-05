import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT_SCRIPT } from "./metrics.ts";
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
const fixture = arg("--fixture", "spa");
const mode = arg("--mode", "cold");
const profile = PROFILES[arg("--profile", "typical")];

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

const fixtureServer = await startFixtureServer(profile);
const wisp = await startWispServer();
const harness = await startHarnessServer(dist, 4620);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: "allow" });
await context.addInitScript(INIT_SCRIPT);
const page = await context.newPage();
await page.goto("http://localhost:4620/");
await page.waitForFunction(
	() => (window as any).__benchReady || (window as any).__benchError,
);
const url = `http://localhost:${FIXTURE_PORT}/${fixture}.html`;
if (mode === "warm") {
	await page.evaluate((u) => (window as any).__benchGo(u), url);
	await page.waitForTimeout(800);
}
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await page.evaluate((u) => (window as any).__benchGo(u), url);
await page.waitForTimeout(1200);
const { profile: prof } = await cdp.send("Profiler.stop");

const self = new Map<number, number>();
const deltas: number[] = prof.timeDeltas;
prof.samples.forEach((id: number, i: number) =>
	self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0)),
);
const byFn = new Map<string, number>();
const byScript = new Map<string, number>();
let total = 0;
for (const node of prof.nodes) {
	const t = self.get(node.id) ?? 0;
	total += t;
	const cf = node.callFrame;
	const where = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, "") : "(native)";
	const key = `${cf.functionName || "(anon)"}  ${where}:${cf.lineNumber}`;
	byFn.set(key, (byFn.get(key) ?? 0) + t);
	const script = cf.url
		? where.split("?")[0]
		: cf.functionName === "(idle)"
			? "(idle)"
			: "(native/gc/program)";
	byScript.set(script, (byScript.get(script) ?? 0) + t);
}
const fmt = (m: Map<string, number>, n: number) =>
	[...m.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`)
		.join("\n");
const idle = byScript.get("(idle)") ?? 0;
console.log(
	`profile: ${distName} ${fixture} ${mode}  busy=${((total - idle) / 1000).toFixed(0)}ms (idle ${(idle / 1000).toFixed(0)}ms)\n`,
);
console.log("-- by script --\n" + fmt(byScript, 12));
console.log("\n-- top self time by function --\n" + fmt(byFn, 25));
await browser.close();
fixtureServer.close();
wisp.close();
harness.close();
process.exit(0);

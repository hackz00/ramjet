import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURE_PAGES } from "./fixtures.ts";
import { verifyFrame, interact } from "./checks.ts";
import { PROFILES, type CpuRate } from "./profiles.ts";
import {
	INIT_SCRIPT,
	collectFrame,
	heapMb,
	processCpuSeconds,
	topLongTasks,
} from "./metrics.ts";
import {
	FIXTURE_PORT,
	startFixtureServer,
	startHarnessServer,
	startWispServer,
	originStats,
	startAssistedForBench,
	type DistDirs,
} from "./servers.ts";
import type { BenchResult, Metrics } from "./compare.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const SETTLE_MS = 800;
const NAV_TIMEOUT_MS = 45_000;

let fixtureScheme: "http" | "https" = "http";
let measureRetention = false;

function parseArgs(argv: string[]) {
	const a: {
		dist: string[];
		profile: string;
		cpu: CpuRate;
		runs: number;
		fixtures: string[];
		out?: string;
		headed: boolean;
		modes: Mode[];

		tls: boolean;

		retention: boolean;

		sharedLink: boolean;
	} = {
		dist: [],
		profile: "typical",
		cpu: 1,
		runs: 5,
		fixtures: [...FIXTURE_PAGES],
		headed: false,
		modes: ["cold", "warm"],
		tls: false,
		retention: false,
		sharedLink: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = () => argv[++i];
		if (k === "--dist") a.dist.push(v());
		else if (k === "--profile") a.profile = v();
		else if (k === "--cpu") a.cpu = Number(v()) as CpuRate;
		else if (k === "--runs") a.runs = Number(v());
		else if (k === "--fixtures") a.fixtures = v().split(",");
		else if (k === "--out") a.out = v();
		else if (k === "--headed") a.headed = true;
		else if (k === "--modes") a.modes = v().split(",") as Mode[];
		else if (k === "--tls") a.tls = true;
		else if (k === "--retention") a.retention = true;
		else if (k === "--shared-link") a.sharedLink = true;
	}
	if (a.dist.length === 0) a.dist.push("current");
	if (!PROFILES[a.profile]) throw new Error(`unknown profile ${a.profile}`);
	const incapable = a.dist.filter((d) => !d.split("+").includes("assisted"));
	if (a.tls && incapable.length)
		throw new Error(
			`--tls serves a self-signed certificate that only the assisted transport accepts; add +assisted to: ${incapable.join(", ")}`,
		);
	fixtureScheme = a.tls ? "https" : "http";
	measureRetention = a.retention;
	return a;
}

function splitDist(spec: string): { name: string; query: string } {
	const [name, ...flags] = spec.split("+");
	const params: string[] = [];
	if (flags.includes("prefetch")) params.push("prefetch=1");
	if (flags.includes("nocache")) params.push("outputcache=0");
	if (flags.includes("assisted")) params.push("transport=assisted");
	if (flags.includes("nostream")) params.push("stream=0");
	if (flags.includes("preconnect")) params.push("preconnect=1");
	if (flags.includes("native")) params.push("native=1");
	return {
		name,
		query: params.length ? `?${params.join("&")}` : "",
		longCache: flags.includes("immutable"),
	};
}

function resolveDist(name: string): DistDirs {
	if (name === "current") {
		return {
			core: path.join(ROOT, "packages/core/dist"),
			controller: path.join(ROOT, "packages/controller/dist"),
		};
	}
	if (name === "baseline") {
		return {
			core: path.join(ROOT, "bench/baseline-dist/core"),
			controller: path.join(ROOT, "bench/baseline-dist/controller"),
		};
	}

	const snapshot = path.join(ROOT, "bench/baseline-dist", name);
	if (existsSync(path.join(snapshot, "core"))) {
		return {
			core: path.join(snapshot, "core"),
			controller: path.join(snapshot, "controller"),
		};
	}
	const p = path.resolve(name);
	return { core: path.join(p, "core"), controller: path.join(p, "controller") };
}

const push = (m: Metrics, k: string, v: number) => (m[k] ??= []).push(v);

type NavMetrics = Record<string, number>;

async function measureNavigation(
	page: Page,
	browserCdp: { send: (m: string) => Promise<any> } | null,
	url: string,
): Promise<NavMetrics> {
	const errors = (page as any).__benchErrors as string[];
	errors.length = 0;
	const topBefore = await topLongTasks(page);
	const cpuBefore = browserCdp ? await processCpuSeconds(browserCdp) : NaN;
	const statsBefore = { ...originStats };
	const nav = (await page.evaluate(
		(u) => (window as any).__benchGo(u),
		url,
	)) as { t0: number; tLoad: number };
	await page.waitForTimeout(SETTLE_MS);
	if (errors.length)
		throw new Error(
			`controller reported request errors: ${errors[0].slice(0, 160)}`,
		);
	const child = page.frames().find((f) => f.parentFrame() === page.mainFrame());
	if (!child) throw new Error("no proxied frame");
	const fm = await collectFrame(child);
	const topAfter = await topLongTasks(page);
	const cpuAfter = browserCdp ? await processCpuSeconds(browserCdp) : NaN;
	const fcp = fm.fcpAbs ? fm.fcpAbs - nav.t0 : NaN;

	const fixtureName = new URL(url).pathname
		.replace(/^\//, "")
		.replace(/\.html$/, "");
	const failures = await verifyFrame(child, fixtureName);
	if (failures.length)
		throw new Error(
			`page check failed (${fixtureName}): ${failures.join("; ")}`,
		);

	const metrics: NavMetrics = {
		fcp,

		lcp: fm.lcpAbs ? fm.lcpAbs - nav.t0 : NaN,
		load: nav.tLoad - nav.t0,
		resP50: fm.resP50,
		resP95: fm.resP95,
		longTasksMs: fm.longTasksMs + (topAfter - topBefore),
		cpuMs: (cpuAfter - cpuBefore) * 1000,
		heapMb: await heapMb(page),

		originConns: originStats.connections - statsBefore.connections,
		originTls: originStats.tlsSessions - statsBefore.tlsSessions,
		originReqs: originStats.requests - statsBefore.requests,
	};

	const startup = (page as any).__startupMs as number | undefined;
	if (startup !== undefined) {
		metrics.startupMs = startup;
		(page as any).__startupMs = undefined;
	}
	const interaction = await interact(page, child);
	if (interaction) {
		Object.assign(metrics, interaction);

		metrics.heapAfterInteractMb = await heapMb(page);
	}
	if (measureRetention) {
		metrics.heapBeforeMb = metrics.heapMb;
		await page.evaluate(() => {
			(document.getElementById("testframe") as HTMLIFrameElement).src =
				"about:blank";
		});
		await page.waitForTimeout(500);
		metrics.heapRetainedMb = await heapMb(page);
	}
	return metrics;
}

async function openHarness(
	context: BrowserContext,
	harnessPort: number,
	query: string,
	cpu: CpuRate,
): Promise<Page> {
	const page: Page = await context.newPage();

	const errors: string[] = [];
	(page as any).__benchErrors = errors;
	page.on("console", (m) => {
		if (
			/Error in controller request handler|failed with error code/.test(
				m.text(),
			)
		)
			errors.push(m.text());
	});
	await context.addInitScript(INIT_SCRIPT);
	const startedAt = Date.now();
	await page.goto(`http://localhost:${harnessPort}/${query}`);
	await page.waitForFunction(
		() => (window as any).__benchReady || (window as any).__benchError,
		null,
		{ timeout: NAV_TIMEOUT_MS },
	);
	const err = await page.evaluate(() => (window as any).__benchError);
	if (err) throw new Error("harness init failed: " + err);
	(page as any).__startupMs = Date.now() - startedAt;
	if (cpu !== 1) {
		const s = await context.newCDPSession(page);
		await s.send("Emulation.setCPUThrottlingRate", { rate: cpu });
	}
	return page;
}

type Mode = "cold" | "warm" | "revisit";

async function measureOnce(
	browser: Browser,
	browserCdp: { send: (m: string) => Promise<any> },
	harnessPort: number,
	query: string,
	fixture: string,
	cpu: CpuRate,
	modes: Mode[],
): Promise<Partial<Record<Mode, NavMetrics>>> {
	const url = `${fixtureScheme}://localhost:${FIXTURE_PORT}/${fixture}.html`;
	const out: Partial<Record<Mode, NavMetrics>> = {};
	if (modes.includes("cold") || modes.includes("warm")) {
		const context = await browser.newContext({ serviceWorkers: "allow" });
		try {
			const page = await openHarness(context, harnessPort, query, cpu);
			const first = await measureNavigation(page, browserCdp, url);
			if (modes.includes("cold")) out.cold = first;
			if (modes.includes("warm"))
				out.warm = await measureNavigation(page, browserCdp, url);
		} finally {
			await context.close();
		}
	}
	if (modes.includes("revisit"))
		out.revisit = await measureRevisit(harnessPort, query, url, cpu);
	return out;
}

async function measureRevisit(
	harnessPort: number,
	query: string,
	url: string,
	cpu: CpuRate,
): Promise<NavMetrics> {
	const userDataDir = mkdtempSync(path.join(tmpdir(), "ramjet-bench-"));
	const launch = () =>
		chromium.launchPersistentContext(userDataDir, {
			headless: true,
			args: ["--enable-precise-memory-info"],
			serviceWorkers: "allow",
		});
	try {
		const first = await launch();
		try {
			const page = await openHarness(first, harnessPort, query, cpu);
			await measureNavigation(page, null, url);

			await page.waitForTimeout(1500);
		} finally {
			await first.close();
		}
		const second = await launch();
		try {
			const page = await openHarness(second, harnessPort, query, cpu);
			return await measureNavigation(page, null, url);
		} finally {
			await second.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const profile = PROFILES[args.profile];
	const fixtureServer = await startFixtureServer(profile, {
		tls: args.tls,
		sharedLink: args.sharedLink,
	});
	const wispServer = await startWispServer();
	const assistedServer = await startAssistedForBench({ insecureTls: args.tls });
	const dists = await Promise.all(
		args.dist.map(async (spec, i) => {
			const { name, query, longCache } = splitDist(spec);
			return {
				name: spec,
				query,
				port: 4610 + i,
				server: await startHarnessServer(resolveDist(name), 4610 + i, {
					longCache,
				}),
			};
		}),
	);
	const browser = await chromium.launch({
		headless: !args.headed,
		args: ["--enable-precise-memory-info"],
	});
	const browserCdp = await browser.newBrowserCDPSession();
	let sha = "unknown";
	try {
		sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
			.toString()
			.trim();
	} catch {}
	const results = new Map<string, BenchResult>();
	for (const d of dists) {
		results.set(d.name, {
			schema: 1,
			meta: {
				dist: d.name,
				profile: args.profile,
				cpu: args.cpu,
				runs: args.runs,
				date: new Date().toISOString(),
				sha,
			},
			fixtures: {},
		});
	}
	let failures = 0;
	try {
		for (let run = 1; run <= args.runs; run++) {
			for (const d of dists) {
				for (const fixture of args.fixtures) {
					try {
						await assistedServer.resetUpstream();
						const m = await measureOnce(
							browser,
							browserCdp,
							d.port,
							d.query,
							fixture,
							args.cpu,
							args.modes,
						);
						const res = results.get(d.name)!;
						const parts: string[] = [];
						for (const mode of args.modes) {
							const nav = m[mode];
							if (!nav) continue;
							const slot = ((res.fixtures[fixture] ??= {})[mode] ??= {});
							for (const [k, v] of Object.entries(nav))
								if (Number.isFinite(v)) push(slot, k, v);
							parts.push(
								`${mode} fcp=${nav.fcp?.toFixed?.(0)} load=${nav.load.toFixed(0)}`,
							);
						}
						process.stdout.write(
							`run ${run}/${args.runs} ${d.name} ${fixture}: ${parts.join(" | ")}
`,
						);
					} catch (e) {
						failures++;
						process.stdout.write(
							`run ${run} ${d.name} ${fixture}: FAILED ${(e as Error).message}\n`,
						);
					}
				}
			}
		}
	} finally {
		await browser.close();
		fixtureServer.close();
		wispServer.close();
		await assistedServer.close();
		for (const d of dists) d.server.close();
	}
	const outDir = path.resolve(__dirname, "../results");
	mkdirSync(outDir, { recursive: true });
	for (const [name, res] of results) {
		const file =
			args.out && results.size === 1
				? path.resolve(args.out)
				: path.join(outDir, `${name}-${args.profile}-cpu${args.cpu}.json`);
		writeFileSync(file, JSON.stringify(res, null, 1));
		process.stdout.write(`wrote ${file}\n`);
	}
	if (failures) process.stdout.write(`${failures} measurement(s) failed\n`);
	process.exit(failures ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});

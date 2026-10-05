export type Metrics = Record<string, number[]>;

export interface BenchResult {
	schema: 1;
	meta: {
		dist: string;
		profile: string;
		cpu: number;
		runs: number;
		date: string;
		sha: string;
	};

	fixtures: Record<string, Record<string, Metrics>>;
}

export interface Gates {
	[metric: string]: number;
}

export const DEFAULT_GATES: Gates = {
	fcp: 2,
	lcp: 2,
	load: 2,
	resP50: 2,
	resP95: 2,
	heapMb: 5,
	heapAfterInteractMb: 5,
	heapRetainedMb: 5,

	startupMs: 5,
	inpMs: 10,
	frameGapP95: 10,
};

const EXCUSABLE_METRICS = new Set(["resP50", "resP95"]);

export interface Row {
	fixture: string;
	mode: string;
	metric: string;
	base: number;
	cand: number;
	pct: number;
	ciLow: number;
	ciHigh: number;
	status: "win" | "neutral" | "regress" | "excused" | "missing";
	gated: boolean;
}

export function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function bootstrapPct(
	base: number[],
	cand: number[],
	resamples = 4000,
): { pct: number; low: number; high: number } {
	const mb = median(base);
	const mc = median(cand);
	const pct = mb === 0 ? 0 : ((mc - mb) / mb) * 100;
	const rnd = mulberry32(0x5eed);
	const draw = (xs: number[]) => {
		const out = new Array<number>(xs.length);
		for (let i = 0; i < xs.length; i++) out[i] = xs[(rnd() * xs.length) | 0];
		return out;
	};
	const samples: number[] = [];
	for (let i = 0; i < resamples; i++) {
		const b = median(draw(base));
		const c = median(draw(cand));
		samples.push(b === 0 ? 0 : ((c - b) / b) * 100);
	}
	samples.sort((a, b) => a - b);
	return {
		pct,
		low: samples[Math.floor(resamples * 0.025)],
		high: samples[Math.floor(resamples * 0.975)],
	};
}

export interface CompareOptions {
	minSamples?: number;

	requireImprovement?: boolean;
}

const PRIMARY = new Set(["fcp", "lcp", "load"]);

export function compare(
	base: BenchResult,
	cand: BenchResult,
	gates: Gates = DEFAULT_GATES,
	options: CompareOptions = {},
): { pass: boolean; improved: boolean; rows: Row[] } {
	const rows: Row[] = [];
	for (const [fixture, modes] of Object.entries(base.fixtures)) {
		for (const [mode, metrics] of Object.entries(modes)) {
			const candMetrics = cand.fixtures[fixture]?.[mode];
			for (const [metric, bs] of Object.entries(metrics)) {
				if (bs.length === 0) continue;
				const cs = candMetrics?.[metric] ?? [];
				const gated = gates[metric] !== undefined;
				const needed =
					options.minSamples ?? Math.max(3, Math.ceil(bs.length * 0.8));
				if (cs.length < Math.min(needed, bs.length)) {
					rows.push({
						fixture,
						mode,
						metric,
						base: median(bs),
						cand: cs.length ? median(cs) : NaN,
						pct: NaN,
						ciLow: NaN,
						ciHigh: NaN,
						status: "missing",
						gated,
					});
					continue;
				}
				const { pct, low, high } = bootstrapPct(bs, cs);
				const gate = gates[metric];
				let status: Row["status"] = "neutral";
				if (high < 0) status = "win";
				else if (gated && pct > gate && low > 0) status = "regress";
				rows.push({
					fixture,
					mode,
					metric,
					base: median(bs),
					cand: median(cs),
					pct,
					ciLow: low,
					ciHigh: high,
					status,
					gated,
				});
			}
		}
	}
	for (const r of rows) {
		if (r.status !== "regress" || !EXCUSABLE_METRICS.has(r.metric)) continue;
		const winsOn = (metric: string) =>
			rows.some(
				(x) =>
					x.fixture === r.fixture &&
					x.mode === r.mode &&
					x.metric === metric &&
					x.status === "win",
			);
		if (winsOn("fcp") && winsOn("load")) r.status = "excused";
	}
	const improved = rows.some(
		(r) => r.status === "win" && PRIMARY.has(r.metric),
	);
	const clean = !rows.some(
		(r) => r.status === "regress" || r.status === "missing",
	);
	return {
		pass: clean && (!options.requireImprovement || improved),
		improved,
		rows,
	};
}

export function formatRows(rows: Row[]): string {
	const lines = [
		"fixture/mode/metric            base      cand     change   95% CI           verdict",
	];
	for (const r of rows) {
		lines.push(
			`${(r.fixture + "/" + r.mode + "/" + r.metric).padEnd(30)} ${r.base
				.toFixed(1)
				.padStart(
					8,
				)} ${r.cand.toFixed(1).padStart(9)} ${(r.pct >= 0 ? "+" : "") + r.pct.toFixed(1)}%`.padEnd(
				72,
			) + ` [${r.ciLow.toFixed(1)}, ${r.ciHigh.toFixed(1)}]  ${r.status}`,
		);
	}
	return lines.join("\n");
}

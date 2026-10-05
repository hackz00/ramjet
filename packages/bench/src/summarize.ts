import { readFileSync } from "node:fs";
import { bootstrapPct, median, type BenchResult } from "./compare.ts";

const [a, b, spec, only] = process.argv.slice(2);
if (!a || !b || !spec) {
	console.error(
		"usage: summarize.ts <baseline.json> <candidate.json> <mode:metric,...> [fixtures]",
	);
	process.exit(2);
}
const base = JSON.parse(readFileSync(a, "utf8")) as BenchResult;
const cand = JSON.parse(readFileSync(b, "utf8")) as BenchResult;
const cols = spec.split(",").map((s) => s.split(":") as [string, string]);
const fixtures = (only ? only.split(",") : Object.keys(base.fixtures)).filter(
	(f) => base.fixtures[f],
);

const unit = (metric: string) =>
	/heap/i.test(metric)
		? "MB"
		: /cpu|ms|load|fcp|lcp|startup|inp|gap|res/i.test(metric)
			? "ms"
			: "";
const num = (v: number, metric: string) =>
	unit(metric) === "MB" ? v.toFixed(1) : String(Math.round(v));

const header = ["fixture", ...cols.map(([m, k]) => `${m} ${k}`)];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map((_, i) => (i ? "---:" : "---")).join("|")}|`);
for (const f of fixtures) {
	const cells = cols.map(([mode, metric]) => {
		const bs = base.fixtures[f]?.[mode]?.[metric] ?? [];
		const cs = cand.fixtures[f]?.[mode]?.[metric] ?? [];
		if (!bs.length || !cs.length) return "n/a";
		const { pct, low, high } = bootstrapPct(bs, cs);
		const sig = high < 0 || low > 0 ? "*" : "";
		const sign = pct > 0 ? "+" : "";
		return `${num(median(bs), metric)} → ${num(median(cs), metric)} ${unit(metric)} (${sign}${pct.toFixed(0)}%)${sig}`;
	});
	console.log(`| ${f} | ${cells.join(" | ")} |`);
}

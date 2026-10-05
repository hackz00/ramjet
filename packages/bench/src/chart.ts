import { readFileSync, writeFileSync } from "node:fs";
import { median, type BenchResult } from "./compare.ts";

export interface BarRow {
	label: string;
	base: number;
	cand: number;
}

const UPSTREAM = "Scram" + "jet";

const W = 760;
const PAD = 24;
const LABEL_W = 150;
const ROW_H = 46;
const BAR_H = 15;

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (v: number, unit: string) =>
	(unit === "MB" ? v.toFixed(1) : String(Math.round(v))) + " " + unit;

function frame(
	title: string,
	subtitle: string,
	bodyH: number,
	body: string,
	legend: string,
): string {
	const H = PAD + 34 + (subtitle ? 18 : 0) + bodyH + 34 + PAD;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="13" role="img" aria-label="${esc(title)}">
<style>
  .card{fill:#ffffff;stroke:#d5dbe3}
  .t{fill:#14213d;font-size:17px;font-weight:600} .s{fill:#5b6675;font-size:12.5px}
  .l{fill:#1f2933;font-size:13px} .v{fill:#1f2933;font-size:12px}
  .base{fill:#a7b1bd} .cand{fill:#1f5fe0} .good{fill:#0e8a4f;font-size:12px;font-weight:600} .bad{fill:#c2410c;font-size:12px;font-weight:600}
  .regression{fill:#c2410c} .axis{stroke:#e3e8ee} .zero{stroke:#7b8794}
  @media (prefers-color-scheme: dark){
    .card{fill:#0f1720;stroke:#2b3745} .t{fill:#f1f5f9} .s{fill:#9fb0c3} .l,.v{fill:#e5ebf2}
    .base{fill:#5c6b7c} .cand{fill:#5b9bff} .good{fill:#4ade80} .bad{fill:#fb923c} .axis{stroke:#243241} .zero{stroke:#9fb0c3} .regression{fill:#fb923c}
  }
</style>
<rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6"/>
<text class="t" x="${PAD}" y="${PAD + 18}">${esc(title)}</text>
${subtitle ? `<text class="s" x="${PAD}" y="${PAD + 38}">${esc(subtitle)}</text>` : ""}
${body}
${legend}
</svg>
`;
}

export function barChart(
	title: string,
	subtitle: string,
	rows: BarRow[],
	unit: string,
	labels = [UPSTREAM + " 2.0.67 (upstream)", "Ramjet"],
): string {
	const top = PAD + 34 + (subtitle ? 18 : 0);
	const max = Math.max(...rows.flatMap((r) => [r.base, r.cand])) * 1.0;
	const barX = PAD + LABEL_W;
	const barMax = W - barX - PAD - 120;
	let body = "";
	rows.forEach((r, i) => {
		const y = top + i * ROW_H;
		const wb = Math.max(2, (r.base / max) * barMax);
		const wc = Math.max(2, (r.cand / max) * barMax);
		const pct = ((r.cand - r.base) / r.base) * 100;
		const good = pct <= 0;
		body += `<text class="l" x="${PAD}" y="${y + 20}">${esc(r.label)}</text>
<rect class="base" x="${barX}" y="${y + 4}" width="${wb.toFixed(1)}" height="${BAR_H}" rx="3"/>
<text class="v" x="${barX + wb + 6}" y="${y + 16}">${fmt(r.base, unit)}</text>
<rect class="cand" x="${barX}" y="${y + 4 + BAR_H + 3}" width="${wc.toFixed(1)}" height="${BAR_H}" rx="3"/>
<text class="v" x="${barX + wc + 6}" y="${y + 16 + BAR_H + 3}">${fmt(r.cand, unit)}</text>
<text class="${good ? "good" : "bad"}" x="${W - PAD}" y="${y + 28}" text-anchor="end">${pct <= 0 ? "" : "+"}${pct.toFixed(0)}%</text>
`;
	});
	const ly = top + rows.length * ROW_H + 14;
	const legend = `<rect class="base" x="${PAD}" y="${ly - 10}" width="12" height="12" rx="2"/><text class="s" x="${PAD + 18}" y="${ly}">${esc(labels[0])}</text>
<rect class="cand" x="${PAD + 230}" y="${ly - 10}" width="12" height="12" rx="2"/><text class="s" x="${PAD + 248}" y="${ly}">${esc(labels[1])}</text>
<text class="s" x="${W - PAD}" y="${ly}" text-anchor="end">lower is better</text>`;
	return frame(title, subtitle, rows.length * ROW_H, body, legend);
}

export function changeChart(
	title: string,
	subtitle: string,
	rows: { label: string; pct: number }[],
): string {
	const top = PAD + 34 + (subtitle ? 18 : 0);
	const rowH = 26;
	const extent = Math.max(20, ...rows.map((r) => Math.abs(r.pct))) * 1.1;
	const midX =
		PAD +
		330 +
		(W - PAD * 2 - 330 - 70) *
			(Math.max(0, ...rows.map((r) => r.pct)) > 0 ? 0.55 : 0.85);
	const scale = (midX - (PAD + 330)) / extent;
	let body = `<line class="zero" x1="${midX}" x2="${midX}" y1="${top - 4}" y2="${top + rows.length * rowH}"/>`;
	rows.forEach((r, i) => {
		const y = top + i * rowH;
		const w = Math.max(1.5, Math.abs(r.pct) * scale);
		const x = r.pct <= 0 ? midX - w : midX;
		const good = r.pct <= 0;
		body += `<text class="l" x="${PAD}" y="${y + 14}">${esc(r.label)}</text>
<rect class="${good ? "cand" : "regression"}" x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="14" rx="3" ${good ? "" : 'fill="#c2410c"'}/>
<text class="${good ? "good" : "bad"}" x="${r.pct <= 0 ? x - 6 : x + w + 6}" y="${y + 14}" text-anchor="${r.pct <= 0 ? "end" : "start"}">${r.pct <= 0 ? "" : "+"}${r.pct.toFixed(0)}%</text>
`;
	});
	const ly = top + rows.length * rowH + 16;
	const legend = `<text class="s" x="${PAD}" y="${ly}">Bars left of the line: Ramjet is faster / uses less than upstream ${UPSTREAM}. Right: it is slower / uses more.</text>`;
	return frame(title, subtitle, rows.length * rowH, body, legend);
}

const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as BenchResult;
const med = (r: BenchResult, fixture: string, mode: string, metric: string) =>
	median(r.fixtures[fixture]?.[mode]?.[metric] ?? []);

if (process.argv[1] && process.argv[1].endsWith("chart.ts")) {
	const [cmd, out, title, a, b, p1, p2, p3] = process.argv.slice(2);
	const base = load(a);
	const cand = load(b);
	if (cmd === "bars") {
		const mode = p1;
		const metric = p2;
		const fixtures = (p3 ? p3.split(",") : Object.keys(base.fixtures)).filter(
			(f) => Number.isFinite(med(base, f, mode, metric)),
		);
		const rows = fixtures.map((f) => ({
			label: f,
			base: med(base, f, mode, metric),
			cand: med(cand, f, mode, metric),
		}));
		const unit = /heap|Mb/i.test(metric) ? "MB" : "ms";
		writeFileSync(
			out,
			barChart(
				title,
				`${mode} visit, median of ${base.fixtures[fixtures[0]]?.[mode]?.[metric]?.length ?? "?"} runs`,
				rows,
				unit,
			),
		);
	} else if (cmd === "change") {
		const entries = p1.split(",").map((s) => s.split("/"));
		const names: Record<string, string> = {
			fcp: "first paint",
			load: "page load",
			cpuMs: "CPU time",
			heapMb: "memory after load",
			heapAfterInteractMb: "memory after clicks + scroll",
			heapRetainedMb: "memory kept after leaving the page",
			startupMs: "controller startup",
			inpMs: "click latency (INP)",
			frameGapP95: "scroll smoothness (p95 frame gap)",
		};
		const rows = entries.map(([f, m, metric]) => ({
			label: `${f}: ${names[metric] ?? metric} (${m})`,
			pct:
				((med(cand, f, m, metric) - med(base, f, m, metric)) /
					med(base, f, m, metric)) *
				100,
		}));
		writeFileSync(
			out,
			changeChart(title, "median change vs upstream " + UPSTREAM, rows),
		);
	} else {
		console.error("usage: chart.ts bars|change ...");
		process.exit(2);
	}
	console.log("wrote", out);
}

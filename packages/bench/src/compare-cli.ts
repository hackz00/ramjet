import { readFileSync } from "node:fs";
import { compare, formatRows, type BenchResult } from "./compare.ts";

const args = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const [a, b] = args;
const allowNeutral = process.argv.includes("--allow-neutral");
if (!a || !b) {
	console.error("usage: compare-cli <baseline.json> <candidate.json>");
	process.exit(2);
}
const base = JSON.parse(readFileSync(a, "utf8")) as BenchResult;
const cand = JSON.parse(readFileSync(b, "utf8")) as BenchResult;
const { pass, rows, improved } = compare(base, cand, undefined, {
	requireImprovement: !allowNeutral,
});
console.log(
	formatRows(
		rows.filter((r) => r.gated || r.status === "win" || r.status === "missing"),
	),
);
const regress = rows.filter((r) => r.status === "regress").length;
const missing = rows.filter((r) => r.status === "missing").length;
if (pass)
	console.log(`
PASS: no regressions, nothing missing${improved ? ", improvement found" : ""}`);
else
	console.log(
		`
FAIL: ${regress} regression(s), ${missing} missing measurement(s)` +
			(!improved && !allowNeutral
				? ", no significant improvement on fcp/lcp/load"
				: ""),
	);
process.exit(pass ? 0 : 1);

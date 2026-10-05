import { test } from "node:test";
import assert from "node:assert/strict";
import {
	compare,
	median,
	type BenchResult,
	DEFAULT_GATES,
} from "../src/compare.ts";

function result(overrides: Record<string, number[]>): BenchResult {
	const base: Record<string, number[]> = {
		fcp: [1000, 1010, 990, 1005, 995, 1002, 998, 1001, 999, 1003],
		lcp: [1500, 1510, 1490, 1505, 1495, 1502, 1498, 1501, 1499, 1503],
		load: [2000, 2010, 1990, 2005, 1995, 2002, 1998, 2001, 1999, 2003],
		resP50: [50, 51, 49, 50, 50, 51, 49, 50, 50, 51],
		resP95: [200, 201, 199, 200, 200, 201, 199, 200, 200, 201],
		heapMb: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
	};
	return {
		schema: 1,
		meta: { dist: "x", profile: "fast", cpu: 1, runs: 10, date: "t", sha: "s" },
		fixtures: { page: { cold: { ...base, ...overrides } } },
	};
}
const scale = (a: number[], k: number) => a.map((x) => x * k);

test("median handles odd and even lengths", () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("identical inputs pass with no wins", () => {
	const r = compare(result({}), result({}), DEFAULT_GATES);
	assert.equal(r.pass, true);
	assert.equal(r.rows.filter((x) => x.status === "win").length, 0);
});

test("fcp more than 2% worse fails", () => {
	const a = result({});
	const b = result({ fcp: scale(a.fixtures.page.cold.fcp, 1.05) });
	const r = compare(a, b, DEFAULT_GATES);
	assert.equal(r.pass, false);
	assert.ok(r.rows.some((x) => x.metric === "fcp" && x.status === "regress"));
});

test("fcp 10% better passes and is a win", () => {
	const a = result({});
	const b = result({ fcp: scale(a.fixtures.page.cold.fcp, 0.9) });
	const r = compare(a, b, DEFAULT_GATES);
	assert.equal(r.pass, true);
	assert.ok(r.rows.some((x) => x.metric === "fcp" && x.status === "win"));
});

test("heap 6% worse fails (5% gate)", () => {
	const a = result({});
	const b = result({ heapMb: scale(a.fixtures.page.cold.heapMb, 1.06) });
	const r = compare(a, b, DEFAULT_GATES);
	assert.equal(r.pass, false);
});

test("1% worse is within the 2% gate", () => {
	const a = result({});
	const b = result({ fcp: scale(a.fixtures.page.cold.fcp, 1.01) });
	assert.equal(compare(a, b, DEFAULT_GATES).pass, true);
});

test("per-resource latency regression is excused when fcp and load both win", () => {
	const a = result({});
	const b = result({
		fcp: scale(a.fixtures.page.cold.fcp, 0.8),
		load: scale(a.fixtures.page.cold.load, 0.8),
		resP50: scale(a.fixtures.page.cold.resP50, 1.2),
	});
	const r = compare(a, b, DEFAULT_GATES);
	assert.equal(r.pass, true);
	assert.ok(
		r.rows.some((x) => x.metric === "resP50" && x.status === "excused"),
	);
});

test("per-resource latency regression still fails when fcp does not win", () => {
	const a = result({});
	const b = result({
		load: scale(a.fixtures.page.cold.load, 0.8),
		resP50: scale(a.fixtures.page.cold.resP50, 1.2),
	});
	assert.equal(compare(a, b, DEFAULT_GATES).pass, false);
});

test("a candidate with no measurements for a baseline metric fails", () => {
	const a = result({});
	const b = result({ fcp: [] });
	const r = compare(a, b, DEFAULT_GATES);
	assert.equal(r.pass, false);
	assert.ok(r.rows.some((x) => x.metric === "fcp" && x.status === "missing"));
});

test("a candidate with too few samples fails, and a missing fixture fails", () => {
	const a = result({});
	const few = result({ fcp: [1000, 1001] });
	assert.equal(compare(a, few, DEFAULT_GATES).pass, false);
	const gone: BenchResult = { ...result({}), fixtures: {} };
	const r = compare(a, gone, DEFAULT_GATES);
	assert.equal(r.pass, false);
	assert.ok(r.rows.some((x) => x.status === "missing"));
});

test("metrics absent from the baseline are not required of the candidate", () => {
	const a = result({ lcp: [] });
	const b = result({ lcp: [] });
	assert.equal(compare(a, b, DEFAULT_GATES).pass, true);
});

test("requireImprovement demands a significant win on fcp, lcp or load", () => {
	const a = result({});
	assert.equal(
		compare(a, result({}), DEFAULT_GATES, { requireImprovement: true }).pass,
		false,
	);
	const better = result({ load: scale(a.fixtures.page.cold.load, 0.8) });
	const r = compare(a, better, DEFAULT_GATES, { requireImprovement: true });
	assert.equal(r.pass, true);
	assert.equal(r.improved, true);

	const heapOnly = result({ heapMb: scale(a.fixtures.page.cold.heapMb, 0.8) });
	assert.equal(
		compare(a, heapOnly, DEFAULT_GATES, { requireImprovement: true }).pass,
		false,
	);
});

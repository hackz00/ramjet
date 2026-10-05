import type { Page, Frame } from "playwright";

export const INIT_SCRIPT = `(() => {
	if (window.__bm) return;
	const bm = (window.__bm = { fcp: 0, lcp: 0, lt: 0, origin: performance.timeOrigin });
	const obs = (type, cb) => { try { new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true }); } catch {} };
	obs("longtask", (es) => { for (const e of es) bm.lt += e.duration; });
	bm.ev = 0;
	try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > bm.ev) bm.ev = e.duration; }).observe({ type: "event", durationThreshold: 16, buffered: true }); } catch {}
	window.__sampleFrames = (ms) => new Promise((resolve) => {
		const gaps = []; let last = performance.now(); const end = last + ms;
		const tick = (t) => { gaps.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else resolve(gaps); };
		requestAnimationFrame(tick);
	});
	obs("paint", (es) => { for (const e of es) if (e.name === "first-contentful-paint") bm.fcp = e.startTime; });
	obs("largest-contentful-paint", (es) => { if (es.length) bm.lcp = es[es.length - 1].startTime; });
})();`;

export interface FrameMetrics {
	fcpAbs: number;
	lcpAbs: number;
	longTasksMs: number;
	resP50: number;
	resP95: number;
	resCount: number;
}

export async function collectFrame(frame: Frame): Promise<FrameMetrics> {
	return frame.evaluate(() => {
		const bm = (window as any).__bm ?? {
			fcp: 0,
			lcp: 0,
			lt: 0,
			origin: performance.timeOrigin,
		};
		const lat = performance
			.getEntriesByType("resource")
			.map((e: any) => e.responseStart - e.startTime)
			.filter((x: number) => x > 0)
			.sort((a: number, b: number) => a - b);
		const q = (p: number) =>
			lat.length
				? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]
				: 0;
		return {
			fcpAbs: bm.fcp ? bm.origin + bm.fcp : 0,
			lcpAbs: bm.lcp ? bm.origin + bm.lcp : 0,
			longTasksMs: bm.lt,
			resP50: q(0.5),
			resP95: q(0.95),
			resCount: lat.length,
		};
	});
}

export async function topLongTasks(page: Page): Promise<number> {
	return page.evaluate(() => (window as any).__bm?.lt ?? 0);
}

export async function heapMb(page: Page): Promise<number> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");

	await cdp.send("HeapProfiler.enable");
	await cdp.send("HeapProfiler.collectGarbage");
	const { metrics } = await cdp.send("Performance.getMetrics");
	const used =
		metrics.find((m: any) => m.name === "JSHeapUsedSize")?.value ?? 0;
	await cdp.detach();
	let total = used;
	const parts: Record<string, number> = { page: used / 1048576 };
	const workers = [...page.context().serviceWorkers(), ...page.workers()];
	for (const w of workers) {
		try {
			const v = await w.evaluate(
				() => (performance as any).memory?.usedJSHeapSize ?? 0,
			);
			total += v;
			parts[w.url().split("/").pop() ?? "worker"] = v / 1048576;
		} catch {}
	}
	if (process.env.BENCH_HEAP_DEBUG)
		console.error("heap parts MB", JSON.stringify(parts));
	return total / (1024 * 1024);
}

export async function processCpuSeconds(browserSession: {
	send: (m: string) => Promise<any>;
}): Promise<number> {
	const info = await browserSession.send("SystemInfo.getProcessInfo");
	return (info.processInfo as { cpuTime: number }[]).reduce(
		(s, p) => s + p.cpuTime,
		0,
	);
}

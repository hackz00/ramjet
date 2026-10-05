import type { Frame, Page } from "playwright";
import { FONT_IS_REAL } from "./fixtures.ts";

export async function verifyFrame(
	frame: Frame,
	fixture: string,
): Promise<string[]> {
	return frame.evaluate(
		async ({ fixture, fontReal }) => {
			const fails: string[] = [];
			const w = window as any;
			const until = async (
				cond: () => boolean | Promise<boolean>,
				ms = 4000,
			) => {
				const t = Date.now();
				while (Date.now() - t < ms) {
					if (await cond()) return true;
					await new Promise((r) => setTimeout(r, 50));
				}
				return false;
			};
			const expect = (ok: boolean, what: string) => {
				if (!ok) fails.push(what);
			};

			await until(() => [...document.images].every((i) => i.complete));
			const broken = [...document.images].filter(
				(i) => !(i.complete && i.naturalWidth > 0),
			);
			expect(
				broken.length === 0,
				`${broken.length} image(s) not decoded, e.g. ${broken[0]?.src.slice(-60)}`,
			);

			const css = () =>
				parseFloat(
					getComputedStyle(document.querySelector(".c0")!).paddingTop,
				) > 0;
			switch (fixture) {
				case "article":
					expect(document.title.endsWith("ready"), "inline script did not run");
					expect(
						document.querySelectorAll("p").length === 400,
						"article body incomplete",
					);
					expect(await until(css), "stylesheet not applied");
					break;
				case "spa":
					expect(
						await until(() => typeof w.__bundleReady === "number"),
						"bundle did not execute",
					);
					expect(
						await until(() => document.querySelectorAll("li").length === 200),
						"DOM-ready script did not run",
					);
					break;
				case "css-heavy": {
					expect(await until(css), "stylesheet not applied");
					if (fontReal) {
						await document.fonts.ready;
						const faces = [...document.fonts];
						expect(
							faces.length > 0 && faces.every((f) => f.status === "loaded"),
							`font not loaded: ${faces.map((f) => f.status).join(",")}`,
						);
					}
					break;
				}
				case "grid":
					expect(
						document.images.length === 80,
						`expected 80 images, got ${document.images.length}`,
					);
					break;
				case "frames":
					expect(
						await until(() => w.__workerReply === 2),
						"worker did not reply",
					);
					expect(await until(() => w.__fetchCount === 200), "fetch() failed");
					expect(await until(() => w.__xhr > 0), "XMLHttpRequest failed");
					expect(
						await until(() => w.__innerReady === 2),
						`iframes did not run their scripts (${w.__innerReady ?? 0}/2)`,
					);
					expect(
						document.body.textContent!.includes("written"),
						"document.write output missing",
					);
					break;
				case "news":
					expect(document.title.endsWith("ready"), "inline script did not run");
					expect(w.__data?.items?.length === 1200, "inline JSON data missing");
					expect(
						document.querySelectorAll("article").length === 1500,
						"document body incomplete",
					);
					break;
				case "interactive":
					expect(
						document.querySelectorAll(".row").length >= 2000,
						"list incomplete",
					);
					break;
			}
			return fails;
		},
		{ fixture, fontReal: FONT_IS_REAL },
	);
}

export type InteractionMetrics = {
	inpMs: number;
	frameGapP95: number;
	longFrames: number;
};

export async function interact(
	page: Page,
	frame: Frame,
): Promise<InteractionMetrics | null> {
	const add = frame.locator("#add");
	if ((await add.count()) === 0) return null;
	await frame.evaluate(() => ((window as any).__bm.ev = 0));
	for (let i = 0; i < 3; i++) {
		await add.click();
		await page.waitForTimeout(150);
	}
	const box = await frame.locator("#list").boundingBox();
	const sampling = frame.evaluate(() => (window as any).__sampleFrames(1600));
	if (box) {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 10; i++) {
			await page.mouse.wheel(0, 300);
			await page.waitForTimeout(120);
		}
	}
	const gaps = (await sampling) as number[];
	const inpMs = await frame.evaluate(() => (window as any).__bm.ev as number);
	const sorted = [...gaps].sort((a, b) => a - b);
	return {
		inpMs,
		frameGapP95: sorted.length
			? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
			: 0,
		longFrames: gaps.filter((g) => g > 50).length,
	};
}

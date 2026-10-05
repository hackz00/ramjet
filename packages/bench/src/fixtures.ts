import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(__dirname, "../../core/rewriter/native/sample");

export interface Asset {
	type: string;
	body: Buffer | string;

	headers?: Record<string, string>;

	validators?: boolean;
}
export type FixtureSet = Record<string, Asset>;

export let FONT_IS_REAL = false;
function loadRealFont(): Buffer {
	const pnpm = path.resolve(__dirname, "../../../node_modules/.pnpm");
	try {
		for (const dir of readdirSync(pnpm)) {
			if (!dir.startsWith("playwright-core@")) continue;
			const assets = path.join(
				pnpm,
				dir,
				"node_modules/playwright-core/lib/vite/dashboard/assets",
			);
			const ttf = readdirSync(assets).find((n) => n.endsWith(".ttf"));
			if (ttf) {
				FONT_IS_REAL = true;
				return readFileSync(path.join(assets, ttf));
			}
		}
	} catch {}
	return Buffer.alloc(30_000, 7);
}

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

export function syntheticBundle(approxBytes: number, seed = 1): string {
	const r = rng(seed);
	const parts: string[] = ['"use strict";var __m={};var __n=0;'];
	let size = 0;
	let i = 0;
	while (size < approxBytes) {
		const id = i++;
		const k = Math.floor(r() * 6);
		let fn: string;
		switch (k) {
			case 0:
				fn = `function f${id}(a,b){var l=window.location;return l.href.length>a?b:l.pathname+${id}}`;
				break;
			case 1:
				fn = `function f${id}(a){return typeof top!=="undefined"&&top!==self?a|${id}:a&${id}}`;
				break;
			case 2:
				fn = `function f${id}(o,k){var v=o&&o[k];if(v==null)return ${id};return typeof v==="string"?v.length+${id}:v}`;
				break;
			case 3:
				fn = `function f${id}(a,b){for(var i=0,s=0;i<a;i++){s+=(i*${id}+b)%7}return s}`;
				break;
			case 4:
				fn = `function f${id}(m){try{parent.postMessage(m,"*")}catch(e){return ${id}}return 0}`;
				break;
			default:
				fn = `var c${id}={a:${id},b:function(x){return x+${id}},get c(){return document.title.length+${id}}};`;
		}
		parts.push(fn);
		parts.push(
			`__m["k${id}"]=${k === 5 ? `c${id}` : `f${id}`};__n+=${id % 3};`,
		);
		size += fn.length + 40;
	}
	parts.push("window.__bundleReady=__n;");
	return parts.join("\n");
}

function lorem(r: () => number, words: number): string {
	const w = [
		"proxy",
		"browser",
		"request",
		"service",
		"worker",
		"stream",
		"render",
		"cache",
		"header",
		"cookie",
		"script",
		"frame",
	];
	const out: string[] = [];
	for (let i = 0; i < words; i++) out.push(w[Math.floor(r() * w.length)]);
	return out.join(" ");
}

const assetHost = (i: number) => `localhost:${4602 + (i % 6)}`;

function css(r: () => number, rules: number, host: string): string {
	const out: string[] = [
		`@import url("http://${host}/extra.css");`,
		"@font-face{font-family:F;src:url(/fonts/f.ttf) format('truetype')}",
	];
	for (let i = 0; i < rules; i++) {
		out.push(
			`.c${i}{margin:${1 + Math.floor(r() * 19)}px;padding:${1 + Math.floor(r() * 11)}px;background:url(http://${assetHost(i)}/img/bg${i % 40}.png?v=${i}) no-repeat;color:#${Math.floor(
				r() * 0xffffff,
			)
				.toString(16)
				.padStart(6, "0")}}`,
		);
	}
	return out.join("\n");
}

export function buildFixtures(scheme: "http" | "https" = "http"): FixtureSet {
	const fixtures = buildHttpFixtures();
	if (scheme === "https") {
		for (const asset of Object.values(fixtures)) {
			if (typeof asset.body === "string")
				asset.body = asset.body.replaceAll(
					"http://localhost:46",
					"https://localhost:46",
				);
		}
	}
	return fixtures;
}

function buildHttpFixtures(): FixtureSet {
	const r = rng(42);
	const f: FixtureSet = {};
	const host = "localhost:4600";

	f["/fonts/f.ttf"] = {
		type: "font/ttf",
		body: loadRealFont(),
		headers: { "Cache-Control": "max-age=3600" },
	};
	f["/extra.css"] = { type: "text/css", body: ".extra{color:red}" };
	for (let i = 0; i < 60; i++) {
		f[`/img/bg${i}.png`] = {
			type: "image/png",
			body: PNG,
			headers: { "Cache-Control": "max-age=3600" },
		};
	}

	{
		const paras: string[] = [];
		for (let i = 0; i < 400; i++) {
			paras.push(
				`<p class="c${i % 50}">${lorem(r, 60)} <a href="/article.html?p=${i}">link ${i}</a></p>`,
			);
		}
		f["/article.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>Article</title><link rel="stylesheet" href="http://localhost:4602/article.css"></head><body><h1>Static article</h1>${paras.join("\n")}<img src="http://localhost:4605/img/bg1.png?a=1" width="100" height="100"><script>document.title+=" ready"</script></body></html>`,
		};
		f["/article.css"] = {
			type: "text/css",
			body: css(r, 300, host),
			headers: { "Cache-Control": "max-age=3600" },
		};
	}

	f["/reval.js"] = {
		type: "application/javascript",
		body: "window.__revalReady = (window.__revalReady || 0) + 1;",
		headers: { "Cache-Control": "max-age=1" },
		validators: true,
	};
	f["/reval.html"] = {
		type: "text/html; charset=utf-8",
		body: '<!doctype html><html><head><meta charset="utf-8"><title>reval</title></head><body><script src="http://localhost:4604/reval.js"></script></body></html>',
	};

	{
		f["/spa-bundle.js"] = {
			type: "application/javascript",
			body: syntheticBundle(1_500_000, 7),
			headers: { "Cache-Control": "max-age=3600" },
		};
		let vendor = "";
		try {
			f["/vendor-google.js"] = {
				type: "application/javascript",
				body: readFileSync(path.join(SAMPLE_DIR, "google.js")),
				headers: { "Cache-Control": "max-age=3600" },
			};
			f["/vendor-discord.js"] = {
				type: "application/javascript",
				body: readFileSync(path.join(SAMPLE_DIR, "discord.js")),
				headers: { "Cache-Control": "max-age=3600" },
			};
			vendor = `<script src="http://localhost:4603/vendor-google.js" defer></script><script src="http://localhost:4603/vendor-discord.js" defer></script>`;
		} catch {}
		f["/spa.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>SPA</title><style>body{font:16px sans-serif}#app{padding:24px}</style></head><body><div id="app"><h1>App shell</h1><p>${lorem(r, 40)}</p></div><script src="http://localhost:4604/spa-bundle.js" defer></script>${vendor}<script defer>addEventListener("DOMContentLoaded",()=>{document.getElementById("app").insertAdjacentHTML("beforeend","<ul>"+Array.from({length:200},(_,i)=>"<li>row "+i+"</li>").join("")+"</ul>")})</script></body></html>`,
		};
	}

	{
		const items: string[] = [];
		for (let i = 0; i < 1500; i++) {
			items.push(
				`<article class="c${i % 50}"><h2><a href="/news.html?story=${i}">Story ${i}: ${lorem(r, 6)}</a></h2><p>${lorem(r, 40)}</p></article>`,
			);
		}
		const data = JSON.stringify({
			items: Array.from({ length: 1200 }, (_, i) => ({
				id: i,
				t: lorem(r, 5),
			})),
		});
		f["/news.css"] = {
			type: "text/css",
			body: css(r, 200, host),
			headers: { "Cache-Control": "max-age=3600" },
		};
		f["/news.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>News</title><link rel="stylesheet" href="http://localhost:4602/news.css"></head><body><h1>News</h1>${items.join("\n")}<script>window.__data=${data};document.title+=" ready"</script></body></html>`,
		};
	}

	{
		const rows: string[] = [];
		for (let i = 0; i < 2000; i++)
			rows.push(`<div class="row">row ${i} ${lorem(r, 4)}</div>`);
		f["/interactive.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>Interactive</title><style>#list{height:500px;overflow:auto;border:1px solid #ccc}.row{padding:4px;border-bottom:1px solid #ddd}</style></head><body><button id="add">add rows</button><div id="list">${rows.join("")}</div><script>document.getElementById("add").addEventListener("click",()=>{const l=document.getElementById("list");for(let i=0;i<300;i++){const d=document.createElement("div");d.className="row";d.textContent="new row "+i+" "+location.href.length;l.appendChild(d)}l.offsetHeight;window.__added=(window.__added||0)+300})</script></body></html>`,
		};
	}

	{
		f["/css-heavy.css"] = {
			type: "text/css",
			body: css(r, 2500, host),
			headers: { "Cache-Control": "max-age=3600" },
		};
		const divs: string[] = [];

		for (let i = 0; i < 100; i++) divs.push(`<div class="c${i}">${i}</div>`);
		f["/css-heavy.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>CSS</title><link rel="stylesheet" href="http://localhost:4602/css-heavy.css"></head><body style="font-family:F,sans-serif">${divs.join("")}</body></html>`,
		};
	}

	{
		const imgs: string[] = [];
		for (let i = 0; i < 80; i++)
			imgs.push(
				`<img src="http://localhost:${4602 + (i % 6)}/img/bg${i % 60}.png?g=${i}" width="48" height="48" loading="eager">`,
			);
		f["/grid.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>Grid</title></head><body><h1>Grid</h1>${imgs.join("")}</body></html>`,
		};
		for (let i = 0; i < 80; i++)
			f[`/img/bg${i % 60}.png?g=${i}`] = { type: "image/png", body: PNG };
	}

	{
		f["/worker.js"] = {
			type: "application/javascript",
			body: `onmessage=e=>{postMessage(e.data+1);};importScripts("/worker-dep.js")`,
		};
		f["/worker-dep.js"] = {
			type: "application/javascript",
			body: "self.depLoaded=true",
		};
		f["/inner.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"></head><body><p id="x">inner</p><script>parent.postMessage("inner-ready","*")</script></body></html>`,
		};
		f["/data.json"] = {
			type: "application/json",
			body: JSON.stringify({
				items: Array.from({ length: 200 }, (_, i) => ({ i })),
			}),
		};
		f["/frames.html"] = {
			type: "text/html; charset=utf-8",
			body: `<!doctype html><html><head><meta charset="utf-8"><title>Frames</title></head><body><h1>Frames</h1><iframe src="/inner.html" width="200" height="80"></iframe><iframe src="/inner.html?b=1" width="200" height="80"></iframe><button onclick="location.hash='x'">go</button><script>
addEventListener("message",e=>{if(e.data==="inner-ready")window.__innerReady=(window.__innerReady||0)+1});
const w=new Worker("/worker.js");w.onmessage=e=>{window.__workerReply=e.data};w.postMessage(1);
fetch("/data.json").then(r=>r.json()).then(j=>{window.__fetchCount=j.items.length});
const x=new XMLHttpRequest();x.open("GET","/data.json?x=1");x.onload=()=>{window.__xhr=x.responseText.length};x.send();
document.write("<p>written</p>");
</script></body></html>`,
		};
	}
	return f;
}

export const FIXTURE_PAGES = [
	"article",
	"spa",
	"css-heavy",
	"grid",
	"frames",
	"news",
	"interactive",
] as const;

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const glue = pathToFileURL(
	path.join(ROOT, "packages/core/rewriter/wasm/out/wasm.js"),
).href;
const samples = ["google.js", "discord.js"].map((f) => ({
	name: f,
	bytes: readFileSync(
		path.join(ROOT, "packages/core/rewriter/native/sample", f),
	),
}));

const globals = {
	wrapfn: "$ramjet$wrap",
	wrappropertybase: "$ramjet__",
	wrappropertyfn: "$ramjet$prop",
	cleanrestfn: "$ramjet$clean",
	importfn: "$ramjet$import",
	rewritefn: "$ramjet$rewrite",
	metafn: "$ramjet$meta",
	wrappostmessagefn: "$ramjet$wrappostmessage",
	pushsourcemapfn: "$ramjet$pushsourcemap",
	trysetfn: "$ramjet$tryset",
	templocid: "$ramjet$temploc",
	tempunusedid: "$ramjet$tempunused",
	prefix: "/~/sj/",
};
const flags = {
	syncxhr: false,
	disableComputedWrap: false,
	rewriterLogs: false,
	captureErrors: false,
	cleanErrors: false,
	scramitize: false,
	sourcemaps: false,
	destructureRewrites: true,
	allowInvalidJs: true,
	debugTrampolines: false,
	allowFailedIntercepts: false,
	encapsulateWorkers: true,
	debugSourceURL: false,
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

for (const [i, file] of process.argv.slice(2).entries()) {
	const bytes = readFileSync(file);
	const mod: any = await import(`${glue}?v=${i}`);
	const t0 = performance.now();
	const module = new WebAssembly.Module(bytes);
	const compileMs = performance.now() - t0;
	mod.initSync({ module });
	const rewriter = new mod.Rewriter();
	const out: string[] = [
		`${path.basename(file)} (${bytes.length} bytes, compile ${compileMs.toFixed(1)} ms)`,
	];
	for (const s of samples) {
		const run = () =>
			rewriter.rewrite_js_bytes(
				globals,
				flags,
				encodeURIComponent,
				new Uint8Array(s.bytes),
				"https://example.com/a.js",
				"bench",
				false,
			);
		for (let w = 0; w < 4; w++) run();
		const times: number[] = [];
		for (let n = 0; n < 15; n++) {
			const t = performance.now();
			run();
			times.push(performance.now() - t);
		}
		const ms = median(times);
		out.push(
			`  ${s.name}: ${ms.toFixed(1)} ms  ${(s.bytes.length / 1048576 / (ms / 1000)).toFixed(1)} MiB/s`,
		);
	}
	console.log(out.join("\n"));
}

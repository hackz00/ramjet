import { initSync, Rewriter } from "../../../rewriter/wasm/out/wasm.js";
import type { JsRewriterOutput } from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, RamjetContext } from "@/shared";

export type { JsRewriterOutput, Rewriter };

import { URLMeta } from "@rewriters/url";
import { Error, TextDecoder_decode } from "@/shared/snapshot";

let wasm_u8: Uint8Array | undefined;
let wasm_module: WebAssembly.Module | undefined;
let wasm_ready = false;

export function setWasm(u8: Uint8Array | ArrayBuffer) {
	wasm_u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
	wasm_module = undefined;
}

export function setWasmModule(module: WebAssembly.Module) {
	wasm_module = module;
	wasm_u8 = undefined;
}

export function hasWasm(): boolean {
	return wasm_ready || wasm_module !== undefined || wasm_u8 !== undefined;
}

const loading = new Map<string, Promise<WebAssembly.Module>>();

export function loadWasmModule(url: string): Promise<WebAssembly.Module> {
	let promise = loading.get(url);
	if (!promise) {
		promise = (async () => {
			try {
				return await WebAssembly.compileStreaming(fetch(url));
			} catch {
				const resp = await fetch(url);
				if (!resp.ok)
					throw new Error(`failed to fetch rewriter wasm: ${resp.status}`);
				return await WebAssembly.compile(await resp.arrayBuffer());
			}
		})();
		promise.catch(() => loading.delete(url));
		loading.set(url, promise);
	}
	return promise;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

function initWasm() {
	if (wasm_ready) return;

	if (!wasm_module) {
		if (!(wasm_u8 instanceof Uint8Array))
			throw new Error("rewriter wasm not found (was setWasm called?)");

		if (!MAGIC.every((x, i) => wasm_u8![i] === x))
			throw new Error(
				"rewriter wasm does not have wasm magic (was it fetched correctly?)\nrewriter wasm contents: " +
					TextDecoder_decode(wasm_u8),
			);

		wasm_module = new WebAssembly.Module(wasm_u8 as unknown as BufferSource);
	}

	initSync({ module: wasm_module });
	wasm_ready = true;
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];
export function getRewriter(
	context: RamjetContext,
	meta: URLMeta,
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new Rewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(path.join(here, "../dist/ramjet.wasm"));

const ctx = {
  config: { flags: { rewriterLogs: false }, siteFlags: {} },
} as any;
const meta = { base: new URL("https://example.com/") } as any;

async function freshModule() {
  vi.resetModules();
  return await import("@rewriters/wasm");
}

function wasmResponse(withMime = true) {
  return new Response(
    wasmBytes,
    withMime ? { headers: { "content-type": "application/wasm" } } : undefined,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("loadWasmModule", () => {
  it("compiles once per URL and returns the same promise", async () => {
    const { loadWasmModule } = await freshModule();
    const fetchMock = vi.fn(async () => wasmResponse());
    vi.stubGlobal("fetch", fetchMock);
    const a = loadWasmModule("http://x/a.wasm");
    const b = loadWasmModule("http://x/a.wasm");
    expect(b).toBe(a);
    expect(await a).toBeInstanceOf(WebAssembly.Module);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to compiling downloaded bytes when the MIME type is wrong", async () => {
    const { loadWasmModule } = await freshModule();
    const fetchMock = vi.fn(async () => wasmResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const module = await loadWasmModule("http://x/b.wasm");
    expect(module).toBeInstanceOf(WebAssembly.Module);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed load", async () => {
    const { loadWasmModule } = await freshModule();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(loadWasmModule("http://x/c.wasm")).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => wasmResponse()),
    );
    await expect(loadWasmModule("http://x/c.wasm")).resolves.toBeInstanceOf(
      WebAssembly.Module,
    );
  });
});

describe("rewriter initialisation", () => {
  it("works from a compiled module without bytes and reuses the instance", async () => {
    const { setWasmModule, getRewriter, hasWasm } = await freshModule();
    expect(hasWasm()).toBe(false);
    setWasmModule(await WebAssembly.compile(wasmBytes));
    expect(hasWasm()).toBe(true);
    const [r1, release1] = getRewriter(ctx, meta);
    release1();
    const [r2, release2] = getRewriter(ctx, meta);
    release2();
    expect(r2).toBe(r1);
  });

  it("rejects bytes that are not wasm", async () => {
    const { setWasm, getRewriter } = await freshModule();
    setWasm(new Uint8Array([1, 2, 3, 4, 5]));
    expect(() => getRewriter(ctx, meta)).toThrow(/magic/);
  });

  it("throws a clear error when nothing was provided", async () => {
    const { getRewriter } = await freshModule();
    expect(() => getRewriter(ctx, meta)).toThrow(/setWasm/);
  });

  it("accepts raw bytes (legacy path) and only compiles them once", async () => {
    const { setWasm, getRewriter } = await freshModule();
    setWasm(new Uint8Array(wasmBytes));
    const compile = vi.spyOn(WebAssembly, "Module");
    getRewriter(ctx, meta)[1]();
    getRewriter(ctx, meta)[1]();
    getRewriter(ctx, meta)[1]();
    expect(compile.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

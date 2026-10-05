# Baseline (upstream scramjet b14b709a, Windows 11, Chromium via Playwright)

Collected 2026-10-02 with `packages/bench`, `--profile typical` (upstream RTT 80 ms, 20 Mbps), cpu x1, 20 runs,
interleaving not needed (single dist). Absolute numbers drift with machine load (~±20 % between sessions);
**every keep/revert decision uses interleaved A/B runs of baseline vs candidate in one invocation.**

| fixture | mode | n | FCP ms | load ms | resP50 ms | resP95 ms | long tasks ms | CPU ms | heap MB |
|---|---|---|---|---|---|---|---|---|---|
| article | cold | 20 | 524 (p95 565) | 1359 | 392 | 764 | 0 | 438 | 11.5 |
| article | warm | 20 | 420 (p95 436) | 417 | 95 | 95 | 0 | 146 | 23.1 |
| spa | cold | 20 | 180 (p95 188) | 1600 | 1279 | 1385 | 0 | 705 | 22.0 |
| spa | warm | 20 | 164 (p95 176) | 159 | 1 | 1 | 0 | 119 | 27.7 |
| css-heavy | cold | 20 | 530 (p95 552) | 519 | 387 | 761 | 0 | 415 | 12.6 |
| css-heavy | warm | 20 | 940 (p95 960) | 929 | 87 | 92 | 0 | 237 | 9.8 |
| grid | cold | 20 | 181 (p95 208) | 1481 | 708 | 1271 | 0 | 475 | 12.4 |
| grid | warm | 20 | 148 (p95 164) | 1423 | 668 | 1230 | 0 | 333 | 17.6 |
| frames | cold | 20 | 181 (p95 220) | 345 | 99 | 108 | 0 | 371 | 8.3 |
| frames | warm | 20 | 136 (p95 152) | 282 | 88 | 95 | 0 | 269 | 13.6 |

Native rewriter microbench (`cargo bench -p js --bench rewrite`, release, nightly): google.js 1.1 MB → 19.5 ms
(**58 MiB/s**), discord.js 299 KB → 5.2 ms (56 MiB/s); source-map generation adds ~2 %.

## Where the main thread goes (cold SPA navigation, profile via `src/profile.ts`)
Busy 277 ms of a 2.8 s window (idle 2547 ms): wasm rewriter 81 ms (~2.9 MB of JS), native/GC/program 93 ms,
scramjet.js 27 ms, **controller.inject.js 23 ms (`l` = base64→Uint8Array decode of the 583 KB wasm)**,
libcurl 21 ms, controller.api 13 ms. => the page is mostly *waiting*: the critical path is
document fetch + 3-4 injected blocking scripts, each a SW→controller→SW round trip, not rewriter CPU.

## Observations that steer the plan
- Per-request latency through SW→controller dominates multi-resource pages (grid: 80 images, 10 at a time → ~1.4 s).
- Warm loads are *not* faster for `grid`/`css-heavy`/`article` (no response cache for rewritten output; only scripts hit the browser cache).
- `css-heavy` warm is slower than cold (940 vs 530 ms): unexplained, investigate with `profile.ts --mode warm`.
- longtask observer reports 0 on every fixture: main-thread blocking is short on these fixtures; `cpuMs` (all processes) is the better CPU signal.

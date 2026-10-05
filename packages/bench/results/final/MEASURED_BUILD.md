# Measured build

The original headline scenarios were measured on the build below, before the Scramjet → Ramjet rename.
The post-rename and post-compat-patches directories contain later comparisons with their own build records.
Chromium via Playwright on Windows 11, profile `typical` (upstream RTT 80 ms, 20 Mbps), interleaved A/B per run, 95 % bootstrap CIs.

- source commit: `1497067413ad96911af14921a77a740fb6923628` (fix(assisted): hand preconnected sockets to undici asynchronously ...)
- upstream baseline: Scramjet `b14b709a` (version 2.0.67-alpha.2), built output in `bench/baseline-dist/` (MANIFEST.sha256)
- the measured dist files are kept in `bench/baseline-dist/measured/` (git-ignored); checksums:

```
5136216948d9fe19f8fb37662969f8c406a06f9d63b93cc58ccd296b8d62d875 *ramjet-external.mjs
e39d4c37281be1b0c1be79d8e46a3692056d97820a8ea60d76978dfdb5470ea4 *ramjet.js
c5782415cb44867f71de925f4939bf4fb07ba45c39bada691f92c3eae3698d0d *ramjet.mjs
eae6a5724c3552740d7ce8ff725f42fd8a2e75111a65fd7c9e4f0d9756a203a5 *ramjet.wasm
5f3a58cf137ccff7528e19d8e574b5b9aa19025d588b7db1c853c359fad3559e *ramjet_bundled.js
577c34d60a22db61abb32cdcba2683f6c1b37197f35b1e9781a4b77cecb81100 *ramjet_bundled.mjs
926abd9cd430d5b58799f266fa3e4b9d63b0a4457d7f60e5687d431527df7ee0 *controller.api.js
bc847636d642822676467e27c3872221bf3e246d0ca89aaa6cd5b3049147450b *controller.inject.js
80fda6f9346583c95e147a6e5a34c17cab1af452914688635197b18f6de266aa *controller.sw.js
```

| directory           | what                                                                                                     | runs |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| headline            | upstream vs Ramjet (assisted), all fixtures, cold/warm/revisit                                           | 7    |
| shared-link         | same, one shared 20 Mbps bottleneck for all origins                                                      | 5    |
| cpu4                | same, CPU throttled 4x, cold/warm                                                                        | 5    |
| interaction         | clicks, scroll, startup, heap after interaction and after leaving the page                               | 10   |
| proxy-tax           | native (no proxy) vs Ramjet; css-heavy native failed its font check (fixture limitation) and is excluded | 7    |
| code-cache          | runtime files with mutable vs immutable HTTP caching (V8 code cache)                                     | 8    |
| preconnect-grid-tls | preconnect on/off over TLS + HTTP/2                                                                      | 15   |
| superseded-\*       | runs invalidated by a bug (see docs/perf/RESULTS.md), kept for the record                                | -    |

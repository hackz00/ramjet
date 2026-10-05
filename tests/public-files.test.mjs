import assert from "node:assert/strict";
import test from "node:test";
import { isPublicFile } from "../scripts/public-files.mjs";

test("keeps source, attribution and reproducible measurements", () => {
	for (const file of [
		"LICENSE",
		"NOTICE.md",
		"packages/core/src/index.ts",
		"scripts/make-release.mjs",
		".github/workflows/release.yml",
		"docs/perf/RESULTS.md",
		"packages/bench/results/final/headline/current.json",
		"bench/baseline-dist/MANIFEST.sha256",
	]) {
		assert.equal(isPublicFile(file), true, file);
	}
});

test("excludes private notes, browser state, generated output and old results", () => {
	for (const file of [
		"docs/SETUP.md",
		"docs/RELEASE.md",
		"docs/RENAME.md",
		"docs/SITE-COMPATIBILITY.md",
		"packages/assisted-server/README.md",
		"CLAUDE.md",
		"docs/NEXT-STEPS.md",
		"docs/CODEX-HANDOFF.md",
		"docs/POPULAR-SITES.md",
		".local/chrome/Default/Cookies",
		".env",
		"packages/demo/.env.local",
		"packages/core/dist/ramjet.js",
		"packages/core/rewriter/target/test",
		"packages/bench/results/old/test.json",
		"bench/baseline-dist/ramjet.js",
		"release-artifacts/runtime.tgz",
		"node_modules/package.json",
	]) {
		assert.equal(isPublicFile(file), false, file);
	}
});

test("treats Windows separators consistently", () => {
	assert.equal(isPublicFile("packages\\core\\src\\index.ts"), true);
	assert.equal(isPublicFile("packages\\core\\dist\\ramjet.js"), false);
});

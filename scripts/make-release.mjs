import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPublicFile } from "./public-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarBinary = process.platform === "win32"
	? path.join(process.env.SystemRoot, "System32", "tar.exe")
	: "tar";
const out = path.join(root, "release-artifacts");
const run = (command, options = {}) =>
	execSync(command, {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, RELEASE: "1" },
		...options,
	});
const capture = (command, cwd = root) =>
	execSync(command, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	}).trim();

export const PACKAGES = [
	"core",
	"controller",
	"utils",
	"bootstrap",
	"create-proxy-app",
	"transport-assisted",
	"assisted-server",
];

export const FORBIDDEN = [
	/(^|\/)\.local\//,
	/(^|\/)\.superpowers\//,
	/(^|\/)\.rsdoctor\//,
	/(^|\/)node_modules\//,
	/chrome-testing-profile/,
	/\.(dmp|pdb|exe|obj)$/i,
	/(^|\/)bench\/baseline-dist\/.*\/./,
	/(^|\/)release-artifacts\//,
	/(^|\/)\.env/,
	/(^|\/)(Cookies|Cookies-journal|Login Data|Local State)$/,
	/(^|\/)packages\/bench\/results\/old\//,
];

const dirty = capture("git status --porcelain --untracked-files=all");
if (dirty) {
	console.error("Release builds require a clean committed checkout.\n" + dirty);
	process.exit(1);
}
const commit = capture("git rev-parse HEAD");
const short = commit.slice(0, 8);
const version = JSON.parse(
	readFileSync(path.join(root, "packages/core/package.json"), "utf8"),
).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!process.argv.includes("--skip-build")) {
	for (const dir of PACKAGES)
		rmSync(path.join(root, "packages", dir, "dist"), {
			recursive: true,
			force: true,
		});
	run("pnpm --filter @ramjet/core run rewriter:build");
	run("pnpm --filter @ramjet/core run build");
	run("pnpm --filter @ramjet/transport-assisted run build");
	run("pnpm --filter @ramjet/assisted-server run build");
}
for (const file of [
	"core/dist/ramjet.js",
	"core/dist/ramjet.wasm",
	"core/dist/types/fetch/index.d.ts",
	"core/dist/types/global.d.ts",
	"controller/dist/controller.api.js",
	"utils/dist/ramjet-utils.js",
	"bootstrap/dist/bootstrap-server.js",
	"create-proxy-app/dist/index.js",
	"transport-assisted/dist/assisted-transport.mjs",
	"assisted-server/dist/cli.mjs",
]) {
	statSync(path.join(root, "packages", file));
}
copyFileSync(
	path.join(root, "README.md"),
	path.join(root, "packages/core/README.md"),
);

console.log("== pack");
for (const dir of PACKAGES) {
	run(`pnpm pack --pack-destination "${out}"`, {
		cwd: path.join(root, "packages", dir),
		env: { ...process.env, RELEASE: "1", npm_config_ignore_scripts: "true" },
	});
}

console.log("== browser build");
const browserDir = path.join(out, ".browser-build");
mkdirSync(browserDir);
for (const [name, folder] of [
	["core", "ramjet"],
	["controller", "controller"],
	["utils", "ramjet"],
	["transport-assisted", "transport"],
]) {
	const source = path.join(root, "packages", name, "dist");
	const destination = path.join(browserDir, folder);
	mkdirSync(destination, { recursive: true });
	for (const file of readdirSync(source).filter((file) =>
		/\.(?:js|mjs|wasm)$/.test(file),
	)) {
		copyFileSync(path.join(source, file), path.join(destination, file));
	}
}
for (const file of ["LICENSE", "NOTICE.md"])
	copyFileSync(path.join(root, file), path.join(browserDir, file));
execFileSync(
	tarBinary,
	[
		"-czf",
		path.join(out, `ramjet-browser-${version}-${short}.tar.gz`),
		"-C",
		browserDir,
		".",
	],
	{ cwd: root },
);
rmSync(browserDir, { recursive: true, force: true });

console.log("== source archive (committed files only)");
const sourceName = `ramjet-source-${version}-${short}.tar.gz`;
const publicPaths = execFileSync(
	"git",
	["ls-tree", "-r", "--name-only", "-z", "HEAD"],
	{ cwd: root, encoding: "utf8" },
)
	.split("\0")
	.filter(Boolean)
	.filter(isPublicFile);
execFileSync(
	"git",
	[
		"archive",
		"--format=tar.gz",
		`--prefix=ramjet-${version}/`,
		"-o",
		path.join(out, sourceName),
		"HEAD",
		"--",
		...publicPaths,
	],
	{ cwd: root },
);

console.log("== scan archives for private or leftover files");
const problems = [];
for (const file of readdirSync(out).filter(
	(f) => f.endsWith(".tgz") || f.endsWith(".tar.gz"),
)) {
	const names = execFileSync(tarBinary, ["-tzf", file], {
		cwd: out, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
	}).trim().split("\n");
	for (const name of names) {
		if (FORBIDDEN.some((rx) => rx.test(name)))
			problems.push(`${file}: ${name}`);
	}
	console.log(`  ${file}: ${names.length} files`);
}
if (problems.length) {
	console.error(
		"Forbidden files found in release archives:\n" + problems.join("\n"),
	);
	process.exit(1);
}

console.log("== checksums");
const files = readdirSync(out)
	.filter((f) => f.endsWith(".tgz") || f.endsWith(".tar.gz"))
	.sort();
const manifest = files.map((name) => {
	const bytes = readFileSync(path.join(out, name));
	return {
		name,
		bytes: statSync(path.join(out, name)).size,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
});
writeFileSync(
	path.join(out, "SHA256SUMS"),
	manifest.map((m) => `${m.sha256}  ${m.name}`).join("\n") + "\n",
);
writeFileSync(
	path.join(out, "MANIFEST.json"),
	JSON.stringify(
		{ version, commit, builtAt: new Date().toISOString(), files: manifest },
		null,
		2,
	) + "\n",
);

const table = manifest
	.map(
		(m) =>
			`| \`${m.name}\` | ${(m.bytes / 1024).toFixed(0)} KB | \`${m.sha256.slice(0, 16)}…\` |`,
	)
	.join("\n");
writeFileSync(
	path.join(out, "RELEASE-NOTES.md"),
	`# Ramjet ${version} (${short})

Draft release notes, generated by \`scripts/make-release.mjs\`. Review before publishing.

**Chromium browsers only.** Ramjet is a performance-focused fork of Scramjet (Mercury Workshop), licensed AGPL-3.0-only;
the complete corresponding source is the \`ramjet-source-*.tar.gz\` archive below.

## Assets

| file | size | sha256 |
|---|---:|---|
${table}

The browser archive contains the compiled runtime, controller, plugins and assisted transport. The package tarballs contain the server and app tooling. Corresponding source and archive checksums are included.

Assisted is the default transport. Its server handles upstream TLS and can read proxied traffic. Browser-side transports remain available.

Performance charts describe the earlier measured build; dated follow-up results are in docs/perf/RESULTS.md. This release does not claim support for every website.

`,
);
console.log(`\nDone: ${out}\n${manifest.map((m) => `  ${m.name}`).join("\n")}`);

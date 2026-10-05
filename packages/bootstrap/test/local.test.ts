import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findInstalledPackage,
	findWorkspacePackage,
	packageSource,
	resolveLocalPackages,
} from "../src/local.ts";

function install(root: string, name: string, withDist = true) {
	const dir = join(root, "node_modules", ...name.split("/"));
	mkdirSync(join(dir, withDist ? "dist" : ""), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "0.0.0" }),
	);
	return dir;
}

describe("resolving the runtime from node_modules", () => {
	const root = mkdtempSync(join(tmpdir(), "ramjet-local-"));
	const app = join(root, "app", "src");
	mkdirSync(app, { recursive: true });

	test("finds a package installed in an ancestor directory", () => {
		const dir = install(root, "@ramjet/core");
		assert.equal(findInstalledPackage("@ramjet/core", [app]), dir);
		assert.equal(findInstalledPackage("@ramjet/missing", [app]), null);
	});

	test("needs core, controller and utils, each with a built dist", () => {
		assert.equal(
			resolveLocalPackages([app]),
			null,
			"controller and utils are not installed yet",
		);
		install(root, "@ramjet/controller");
		install(root, "@ramjet/utils", false);
		assert.equal(resolveLocalPackages([app]), null, "utils has no dist");
		const utils = install(root, "@ramjet/utils", true);
		const found = resolveLocalPackages([app]);
		assert.ok(found);
		assert.equal(found.utils, utils);
		assert.equal(found.transports.libcurl, undefined);
		const libcurl = install(root, "@mercuryworkshop/libcurl-transport");
		assert.equal(resolveLocalPackages([app])?.transports.libcurl, libcurl);
	});

	test("tries every start directory in order", () => {
		const other = mkdtempSync(join(tmpdir(), "ramjet-other-"));
		const dir = install(other, "@ramjet/core");
		assert.equal(
			findInstalledPackage("@ramjet/core", [
				join(tmpdir(), "nowhere-xyz"),
				other,
			]),
			dir,
		);
		rmSync(other, { recursive: true, force: true });
	});

	test("finds the runtime packages in a workspace checkout that does not list them as dependencies", () => {
		const repo = mkdtempSync(join(tmpdir(), "ramjet-workspace-"));
		for (const [name, dir] of [
			["@ramjet/core", "core"],
			["@ramjet/controller", "controller"],
			["@ramjet/utils", "utils"],
		]) {
			mkdirSync(join(repo, "packages", dir, "dist"), { recursive: true });
			writeFileSync(
				join(repo, "packages", dir, "package.json"),
				JSON.stringify({ name }),
			);
		}
		const inside = join(repo, "packages", "bootstrap", "src");
		mkdirSync(inside, { recursive: true });
		assert.equal(
			resolveLocalPackages([inside]),
			null,
			"no pnpm-workspace.yaml yet: not a workspace",
		);
		writeFileSync(
			join(repo, "pnpm-workspace.yaml"),
			"packages:\n  - packages/*\n",
		);
		assert.equal(
			findWorkspacePackage("@ramjet/core", [inside]),
			join(repo, "packages", "core"),
		);
		assert.equal(findWorkspacePackage("@ramjet/rpc", [inside]), null);
		assert.equal(
			resolveLocalPackages([inside])?.utils,
			join(repo, "packages", "utils"),
		);

		writeFileSync(
			join(repo, "packages", "core", "package.json"),
			JSON.stringify({ name: "something-else" }),
		);
		assert.equal(findWorkspacePackage("@ramjet/core", [inside]), null);
		rmSync(repo, { recursive: true, force: true });
	});

	test("the package source option and environment variable are validated", () => {
		assert.equal(packageSource(undefined), "auto");
		assert.equal(packageSource("local"), "local");
		assert.throws(
			() => packageSource("npm" as never),
			/auto, local or registry/,
		);
		rmSync(root, { recursive: true, force: true });
	});
});

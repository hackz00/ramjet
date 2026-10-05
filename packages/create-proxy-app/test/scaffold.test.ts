import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	scaffold,
	findWorkspaceRoot,
	WORKSPACE_PACKAGES,
} from "../src/scaffold.ts";

const here = resolve(import.meta.dirname, "..");
const workspace = findWorkspaceRoot(here);

describe("scaffolding an app without the npm registry", () => {
	test("this checkout is recognised as a Ramjet workspace", () => {
		assert.ok(workspace);
		assert.ok(existsSync(join(workspace, "packages", "core", "package.json")));
	});

	test("local source links the runtime packages with file: and pins nested ones with overrides", async () => {
		const parent = mkdtempSync(join(tmpdir(), "ramjet-scaffold-"));
		const dir = join(parent, "app");
		try {
			await scaffold({
				projectName: dir,
				scaffoldType: "dedicated",
				source: "local",
			});
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			for (const name of [
				"@ramjet/bootstrap",
				"@ramjet/controller",
				"@ramjet/core",
				"@ramjet/utils",
			]) {
				const spec = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
				assert.match(
					spec,
					/^file:.*packages\/(bootstrap|controller|core|utils)$/,
					name,
				);

				assert.ok(
					existsSync(join(dir, spec.slice("file:".length), "package.json")),
					`${name} -> ${spec}`,
				);
			}
			for (const name of Object.keys(WORKSPACE_PACKAGES)) {
				assert.ok(pkg.overrides[name].startsWith("file:"), `overrides ${name}`);
				assert.equal(pkg.pnpm.overrides[name], pkg.overrides[name]);
			}
			assert.equal(
				pkg.dependencies.express,
				"^4.21.2",
				"third-party dependencies are untouched",
			);
			assert.ok(
				existsSync(join(dir, "server.js")) &&
					existsSync(join(dir, "public", "index.html")),
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("registry source keeps the template's own version ranges", async () => {
		const parent = mkdtempSync(join(tmpdir(), "ramjet-scaffold-"));
		const dir = join(parent, "app");
		try {
			await scaffold({
				projectName: dir,
				scaffoldType: "dedicated",
				source: "registry",
			});
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			assert.equal(pkg.dependencies["@ramjet/bootstrap"], "*");
			assert.equal(pkg.overrides, undefined);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("the template does not point at the upstream project", () => {
		const server = readFileSync(
			join(here, "templates", "default", "server.js"),
			"utf8",
		);
		const pkg = readFileSync(
			join(here, "templates", "default", "package.json"),
			"utf8",
		);

		assert.ok(!new RegExp("scram" + "jet", "i").test(server + pkg));
	});
});

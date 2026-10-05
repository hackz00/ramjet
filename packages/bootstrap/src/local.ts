import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CORE_PACKAGE = "@ramjet/core";
export const CONTROLLER_PACKAGE = "@ramjet/controller";
export const UTILS_PACKAGE = "@ramjet/utils";

import type { PackageSource } from "./common";
export type { PackageSource };

export type LocalPackages = {
	core: string;
	controller: string;
	utils: string;

	transports: { libcurl?: string; epoxy?: string };
};

export function findInstalledPackage(
	name: string,
	startDirs: string[],
): string | null {
	for (const start of startDirs) {
		let dir = resolve(start);
		for (;;) {
			const candidate = join(dir, "node_modules", ...name.split("/"));
			if (existsSync(join(candidate, "package.json"))) return candidate;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

const WORKSPACE_DIRS: Record<string, string> = {
	[CORE_PACKAGE]: "core",
	[CONTROLLER_PACKAGE]: "controller",
	[UTILS_PACKAGE]: "utils",
};

export function findWorkspacePackage(
	name: string,
	startDirs: string[],
): string | null {
	const dirName = WORKSPACE_DIRS[name];
	if (!dirName) return null;
	for (const start of startDirs) {
		let dir = resolve(start);
		for (;;) {
			const candidate = join(dir, "packages", dirName);
			if (
				existsSync(join(dir, "pnpm-workspace.yaml")) &&
				existsSync(join(candidate, "package.json"))
			) {
				try {
					if (
						JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"))
							.name === name
					)
						return candidate;
				} catch {}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

export function resolveLocalPackages(
	startDirs: string[],
): LocalPackages | null {
	const roots = [CORE_PACKAGE, CONTROLLER_PACKAGE, UTILS_PACKAGE].map(
		(name) =>
			findInstalledPackage(name, startDirs) ??
			findWorkspacePackage(name, startDirs),
	);
	const [core, controller, utils] = roots;
	if (!core || !controller || !utils) return null;
	if (
		![core, controller, utils].every((root) => existsSync(join(root, "dist")))
	)
		return null;
	return {
		core,
		controller,
		utils,
		transports: {
			libcurl:
				findInstalledPackage("@mercuryworkshop/libcurl-transport", startDirs) ??
				undefined,
			epoxy:
				findInstalledPackage("@mercuryworkshop/epoxy-transport", startDirs) ??
				undefined,
		},
	};
}

export function packageSource(
	option: PackageSource | undefined,
): PackageSource {
	const value =
		option ??
		(process.env.RAMJET_BOOTSTRAP_SOURCE as PackageSource | undefined) ??
		"auto";
	if (value !== "auto" && value !== "local" && value !== "registry") {
		throw new Error(
			`package source must be auto, local or registry (got "${value}")`,
		);
	}
	return value;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

export type PackageSource = "auto" | "local" | "registry";

interface options {
	projectName: string;
	scaffoldType: string;
	source?: PackageSource;
}

const packageRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export const WORKSPACE_PACKAGES: Record<string, string> = {
	"@ramjet/bootstrap": "packages/bootstrap",
	"@ramjet/controller": "packages/controller",
	"@ramjet/core": "packages/core",
	"@ramjet/utils": "packages/utils",
	"@ramjet/rpc": "packages/rpc",
	"@ramjet/transport-assisted": "packages/transport-assisted",
};

function localTemplateDir(template: string) {
	return path.join(packageRoot, "templates", template);
}

export function findWorkspaceRoot(from: string = packageRoot): string | null {
	let dir = path.resolve(from);
	for (;;) {
		const corePackage = path.join(dir, "packages", "core", "package.json");
		if (
			fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) &&
			fs.existsSync(corePackage)
		) {
			try {
				if (fs.readJsonSync(corePackage).name === "@ramjet/core") return dir;
			} catch {}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export async function localizeDependencies(
	projectDir: string,
	workspaceRoot: string,
): Promise<void> {
	const file = path.join(projectDir, "package.json");
	const pkg = await fs.readJson(file);
	const spec = (name: string) => {
		const relative = path
			.relative(projectDir, path.join(workspaceRoot, WORKSPACE_PACKAGES[name]))
			.split(path.sep)
			.join("/");
		return `file:${relative}`;
	};
	for (const section of ["dependencies", "devDependencies"] as const) {
		for (const name of Object.keys(pkg[section] ?? {})) {
			if (name in WORKSPACE_PACKAGES) pkg[section][name] = spec(name);
		}
	}
	const overrides = Object.fromEntries(
		Object.keys(WORKSPACE_PACKAGES).map((name) => [name, spec(name)]),
	);
	pkg.overrides = { ...pkg.overrides, ...overrides };
	pkg.pnpm = {
		...pkg.pnpm,
		overrides: { ...pkg.pnpm?.overrides, ...overrides },
	};
	await fs.writeJson(file, pkg, { spaces: "\t" });
}

async function template(
	template: string,
	projectName: string,
	source: PackageSource,
) {
	const dir = localTemplateDir(template);
	if (!(await fs.pathExists(dir))) {
		throw new Error(
			`The "${template}" template is missing from this installation of create-ramjet-app (${dir}).`,
		);
	}
	const workspaceRoot = source === "registry" ? null : findWorkspaceRoot();
	if (source === "local" && !workspaceRoot) {
		throw new Error(
			"--source local needs to run from a Ramjet checkout (a workspace that contains packages/core).",
		);
	}
	try {
		await fs.copy(dir, projectName);
		if (workspaceRoot) await localizeDependencies(projectName, workspaceRoot);
	} catch (err: any) {
		if (
			projectName !== "." &&
			projectName !== "./" &&
			projectName.startsWith("../")
		) {
			try {
				fs.rmdirSync(projectName);
			} catch (_) {}
		}
		throw new Error(err.message);
	}

	if (fs.readdirSync(projectName).length === 0) {
		throw new Error(
			"It looks like the folder is empty. \n Please try again later",
		);
	}
}

async function scaffold(opts: options) {
	await template("default", opts.projectName, opts.source ?? "auto");
}

export { scaffold };

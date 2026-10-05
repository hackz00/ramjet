import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicFile } from "./public-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? ".local/github-ready");
if (!output.startsWith(root + path.sep) || output === root)
	throw new Error("Choose a new folder inside this workspace.");
if (existsSync(output))
	throw new Error(
		"The output folder exists. Choose a new folder to preserve the previous copy.",
	);
const listed = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
	{ cwd: root, encoding: "utf8" },
)
	.split("\0")
	.filter(Boolean);
const files = [...new Set(listed)].filter(isPublicFile).sort();
const repo = path.join(output, "repository");
for (const file of files) {
	const source = path.join(root, file);
	if (!existsSync(source)) continue;
	if (!lstatSync(source).isFile())
		throw new Error(`Not a regular file: ${file}`);
	const destination = path.join(repo, file);
	mkdirSync(path.dirname(destination), { recursive: true });
	copyFileSync(source, destination);
}
let upstreamFiles = [];
try {
	upstreamFiles = execFileSync(
		"git",
		["ls-tree", "-r", "--name-only", "b14b709a"],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	)
		.trim()
		.split("\n");
} catch {}
writeFileSync(
	path.join(output, "UPSTREAM-FILES-TO-REVIEW.txt"),
	upstreamFiles
		.filter((file) => !files.includes(file))
		.sort()
		.join("\n") + "\n",
);
const copied = files.filter((file) => existsSync(path.join(repo, file)));
writeFileSync(path.join(output, "FILES.txt"), copied.join("\n") + "\n");
writeFileSync(
	path.join(output, "EXCLUDED.txt"),
	listed
		.filter((file) => !isPublicFile(file))
		.sort()
		.join("\n") + "\n",
);
writeFileSync(
	path.join(output, "COPY-INSTRUCTIONS.txt"),
	`Copy the contents of repository/ into your hackz00/ramjet clone.\nKeep the clone's .git folder. Do not copy this folder's FILES.txt or other helper files.\nRemove tracked upstream files that are absent from FILES.txt; check the deletion list before committing.\nCopying over files alone leaves obsolete assets and workflows in the clone.\nSetup and release instructions are kept locally, outside repository/.\nNothing here pushes, publishes, adds a remote or copies browser data.\n`,
);
console.log(`Prepared ${copied.length} files in ${repo}`);

export function isPublicFile(file) {
	const name = file.replaceAll("\\", "/");
	if (/^(?:\.local|node_modules|release-artifacts|\.git)\//.test(name))
		return false;
	if (/(?:^|\/)(?:node_modules|dist|target|out)\//.test(name)) return false;
	if (/(?:^|\/)\.env(?:$|\.)|\.(?:dmp|pdb|exe|obj)$/i.test(name)) return false;
	if (name.startsWith("bench/baseline-dist/"))
		return /\/(?:BASE_COMMIT|MANIFEST\.sha256)$/.test(name);
	if (name.startsWith("docs/"))
		return /^(?:docs\/perf\/(?:RESULTS|BASELINE)\.md|docs\/perf\/charts\/[^/]+\.svg)$/.test(
			name,
		);
	if (name.startsWith("packages/bench/results/"))
		return /^packages\/bench\/results\/(?:baseline-[^/]+\.json|final\/)/.test(
			name,
		);
	if (/^packages\/.*\/README\.md$/i.test(name)) return false;
	if (/^(?:packages|assets|patches|scripts|tests|\.github)\//.test(name))
		return true;
	return /^(?:README\.md|NOTICE\.md|LICENSE|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|rspack\.config\.ts|devserver\.ts|devlib\.ts|codespace-basic-setup\.sh|\.gitignore|\.prettierignore)$/.test(
		name,
	);
}

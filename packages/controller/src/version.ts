declare const RAMJET_EXPECTED_VERSION: string;
declare const CONTROLLER_VERSION: string;

export const VERSION = CONTROLLER_VERSION;

function assertVersionMatch(
	packageName: string,
	expected: string,
	actual: string
) {
	if (expected !== actual) {
		throw new Error(
			`${packageName} version mismatch: this build expects ${expected}, but the loaded runtime is ${actual}`
		);
	}
}

export function assertRuntimeRamjetVersion() {
	if (typeof $ramjet === "undefined") {
		throw new Error(
			"@ramjet/core is not loaded. Load ramjet before the controller."
		);
	}

	assertVersionMatch(
		"@ramjet/core",
		RAMJET_EXPECTED_VERSION,
		$ramjet.versionInfo.version
	);
}

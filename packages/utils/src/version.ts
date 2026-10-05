declare const RAMJET_EXPECTED_VERSION: string;
declare const CONTROLLER_EXPECTED_VERSION: string;

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

export function assertDependencyVersions() {
	if (typeof $ramjet === "undefined") {
		console.error(
			"@ramjet/core is not loaded. Load ramjet before ramjet-utils."
		);
	}

	assertVersionMatch(
		"@ramjet/core",
		RAMJET_EXPECTED_VERSION,
		$ramjet.versionInfo.version
	);

	if (typeof $ramjetController === "undefined") {
		console.error(
			"@ramjet/controller is not loaded. Load the controller before ramjet-utils."
		);
	}

	assertVersionMatch(
		"@ramjet/controller",
		CONTROLLER_EXPECTED_VERSION,
		$ramjetController.VERSION
	);
}

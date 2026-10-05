import type * as RamjetController from "@ramjet/controller";

declare global {
	const $ramjet: typeof import("@ramjet/core");
	const $ramjetController: typeof RamjetController;
}

export {};

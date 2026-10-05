import type { Controller } from "@ramjet/controller";
declare global {
	function initBootstrap(): Promise<Controller>;
}

export * from "./server";

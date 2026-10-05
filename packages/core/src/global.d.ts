import { RAMJETCLIENT } from "./symbols";

declare global {
	interface Window {
		WASM: string;
		REAL_WASM: Uint8Array;
		[RAMJETCLIENT]: import("./client").RamjetClient;
	}
	interface Document {
		[RAMJETCLIENT]: import("./client").RamjetClient;
	}
	const dbg: {
		log: (message: string, ...args: any[]) => void;
		warn: (message: string, ...args: any[]) => void;
		error: (message: string, ...args: any[]) => void;
		debug: (message: string, ...args: any[]) => void;
		time: (
			meta: import("./shared/rewriters/url").URLMeta,
			before: number,
			type: string,
		) => void;
	};
	type GlobalThis = typeof globalThis;
	type Self = Window & GlobalThis;
}

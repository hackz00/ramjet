declare module "@mercuryworkshop/wisp-js/server" {
	export const server: {
		routeRequest(
			request: import("node:http").IncomingMessage,
			socket: import("node:stream").Duplex,
			head: Buffer,
		): void;
	};
}

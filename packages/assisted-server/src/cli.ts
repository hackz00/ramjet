import { startAssistedServer } from "./server.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};

const host = value("--host") ?? "127.0.0.1";
const token = value("--token") ?? process.env.RAMJET_TOKEN;
const isLoopback =
	host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!isLoopback && !token && !args.includes("--open")) {
	console.error(
		`refusing to listen on ${host} without a token: pass --token (or set RAMJET_TOKEN), or --open to run an open proxy`,
	);
	process.exit(2);
}

const server = await startAssistedServer({
	port: Number(value("--port") ?? process.env.PORT ?? 8090),
	host,
	token,
	guard: { allowPrivate: args.includes("--allow-private") },
});
console.log(
	`ramjet assisted server listening on ${host}:${server.port}/assisted`,
);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));

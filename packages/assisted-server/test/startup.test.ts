import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startAssistedServer } from "../src/server.ts";

test("invalid ports reject before opening a server", async () => {
	for (const port of [-1, 65536, 1.5, NaN, Infinity])
		await assert.rejects(
			startAssistedServer({ port }),
			/port must be an integer/,
		);
	const server = await startAssistedServer({ port: 0 });
	assert.ok(server.port > 0);
	await server.close();
});

test("an occupied port rejects cleanly and startup can succeed after it is released", async () => {
	const occupied = http.createServer((_, res) => res.end("owner"));
	await new Promise<void>((resolve) =>
		occupied.listen(0, "127.0.0.1", resolve),
	);
	const port = (occupied.address() as { port: number }).port;
	try {
		await assert.rejects(startAssistedServer({ port }), { code: "EADDRINUSE" });
		assert.equal(
			await (await fetch(`http://127.0.0.1:${port}`)).text(),
			"owner",
		);
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		await assert.rejects(
			promisify(execFile)(process.execPath, [
				"--no-warnings",
				cli,
				"--port",
				String(port),
			]),
			(error: any) => {
				assert.equal(error.code, 1);
				assert.match(error.stderr, /ramjet assisted server:.*EADDRINUSE/);
				assert.doesNotMatch(error.stderr, /Unhandled|at .*server\.ts/);
				return true;
			},
		);
	} finally {
		await new Promise<void>((resolve) => occupied.close(() => resolve()));
	}
	const server = await startAssistedServer({ port });
	await server.close();
});

test("closing an attached assisted server preserves its owner's HTTP server", async () => {
	const owner = http.createServer((_, res) => res.end("owner"));
	await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
	try {
		const assisted = await startAssistedServer({ server: owner });
		await assisted.close();
		const port = (owner.address() as { port: number }).port;
		assert.equal(
			await (await fetch(`http://127.0.0.1:${port}`)).text(),
			"owner",
		);
	} finally {
		await new Promise<void>((resolve) => owner.close(() => resolve()));
	}
});

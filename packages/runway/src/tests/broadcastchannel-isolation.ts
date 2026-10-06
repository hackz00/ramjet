import assert from "node:assert/strict";
import { serverTest } from "../testcommon.ts";

const test = serverTest({
	name: "broadcastchannel-host-worker-and-inherited-origin-isolation",
	ramjetOnly: true,
	async start(server) {
		server.on("request", (req, res) => {
			if (req.url === "/worker.js") {
				res.writeHead(200, { "Content-Type": "application/javascript" });
				res.end(`onmessage = (event) => {
					const channel = new BroadcastChannel(event.data);
					channel.onmessage = (message) => {
						postMessage(message.data);
						channel.close();
						close();
					};
					postMessage({ ready: true, name: channel.name });
				};`);
			} else {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end("<!doctype html><body>channel fixture</body>");
			}
		});
	},
});

test.playwrightFn = async ({ page, frame, navigate }) => {
	await test.start({ pass: async () => {}, fail: async () => {} });
	const name = "channel-" + Math.random();
	await page.evaluate((name) => {
		(window as any).hostMessages = [];
		const channel = new BroadcastChannel(name);
		channel.onmessage = (e) => (window as any).hostMessages.push(e.data);
		(window as any).hostChannel = channel;
	}, name);
	try {
		await navigate(`http://localhost:${test.port}/`);
		await frame
			.locator("body")
			.filter({ hasText: "channel fixture" })
			.waitFor();
		await frame.locator("body").evaluate((_, base) => {
			for (const id of ["same", "cross", "blank", "srcdoc"]) {
				const child = document.createElement("iframe");
				child.id = id;
				if (id === "srcdoc")
					child.srcdoc = "<!doctype html><body>srcdoc peer</body>";
				else if (id !== "blank") {
					const url = new URL("/peer", base);
					if (id === "cross") url.hostname = "127.0.0.1";
					child.src = url.href;
				}
				document.body.append(child);
				if (id === "blank") void child.contentWindow;
			}
		}, `http://localhost:${test.port}/`);
		for (const id of ["same", "cross", "blank", "srcdoc"]) {
			await frame
				.frameLocator("#" + id)
				.locator("body")
				.evaluate((_, name) => {
					const w = window as any;
					w.received = [];
					w.channel = new BroadcastChannel(name);
					w.channel.onmessage = (event: MessageEvent) =>
						w.received.push(event.data);
				}, name);
		}
		await frame.locator("body").evaluate(async (_, name) => {
			const w = window as any;
			w.channel = new BroadcastChannel(name);
			w.workerMessages = [];
			w.worker = new Worker("/worker.js");
			await new Promise<void>((resolve, reject) => {
				w.worker.onerror = reject;
				w.worker.onmessage = (e: MessageEvent) => {
					if (e.data.ready) {
						if (e.data.name !== name)
							return reject(new Error("worker channel name changed"));
						resolve();
					} else w.workerMessages.push(e.data);
				};
				w.worker.postMessage(name);
			});
			w.channel.postMessage({ value: "isolated payload" });
		}, name);
		for (const id of ["same", "blank", "srcdoc"]) {
			await frame
				.frameLocator("#" + id)
				.locator("body")
				.evaluate(async (_, id) => {
					const w = window as any;
					for (let i = 0; i < 100 && !w.received.length; i++)
						await new Promise((r) => setTimeout(r, 10));
					if (w.received[0]?.value !== "isolated payload")
						throw new Error(
							"same-origin channel failed: " +
								id +
								" " +
								JSON.stringify(w.received),
						);
					w.channel.close();
				}, id);
		}
		const result = await frame.locator("body").evaluate(async () => {
			const w = window as any;
			for (let i = 0; i < 100 && !w.workerMessages.length; i++)
				await new Promise((r) => setTimeout(r, 10));
			return { name: w.channel.name, worker: w.workerMessages };
		});
		assert.equal(result.name, name);
		assert.deepEqual(result.worker, [{ value: "isolated payload" }]);
		await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
		assert.deepEqual(
			await page.evaluate(() => (window as any).hostMessages),
			[],
		);
		assert.deepEqual(
			await frame
				.frameLocator("#cross")
				.locator("body")
				.evaluate(() => (window as any).received),
			[],
		);
	} finally {
		await page.evaluate(() => (window as any).hostChannel?.close());
		await test.stop();
	}
};

export default [test];

import { basicTest, multiFrameTest } from "../../testcommon.ts";

export default [
	basicTest({
		name: "broadcastchannel-string-sanity",
		js: `
			const channel = "ramjet-bc-string-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(event.data, "hello", "message should round-trip as the inner string");
				a.close();
				b.close();
				pass();
			});
			a.postMessage("hello");
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-object-sanity",
		js: `
			const channel = "ramjet-bc-object-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(typeof event.data, "object", "data should be an object");
				assertEqual(event.data.x, 1, "data.x should be 1");
				assertEqual(event.data.y, "two", "data.y should be 'two'");
				a.close();
				b.close();
				pass();
			});
			a.postMessage({ x: 1, y: "two" });
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-envelope-not-leaked",
		js: `
			// The proxy wraps data in an envelope with $ramjet$ keys.
			// Page code must never see those keys on event.data.
			const channel = "ramjet-bc-envelope-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(typeof event.data, "object", "data should be an object");
				assert(!("$ramjet$data" in event.data), "$ramjet$data should not leak");
				assert(!("$ramjet$origin" in event.data), "$ramjet$origin should not leak");
				assert(!("$ramjet$messagetype" in event.data), "$ramjet$messagetype should not leak");
				assertEqual(event.data.payload, "real", "inner payload should be untouched");
				a.close();
				b.close();
				pass();
			});
			a.postMessage({ payload: "real" });
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-onmessage-property",
		js: `
			const channel = "ramjet-bc-onmessage-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.onmessage = (event) => {
			console.log("event", event);
				assertEqual(event.data, "via-onmessage", "data should be unwrapped on onmessage");
				a.close();
				b.close();
				pass();
			};
			a.postMessage("via-onmessage");
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-event-origin-string",
		js: `
			const channel = "ramjet-bc-origin-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(typeof event.origin, "string", "event.origin should be a string");
				assert(event.origin.length > 0, "event.origin should not be empty");
				assert(!event.origin.includes("$ramjet$"), "event.origin should not be the envelope");
				a.close();
				b.close();
				pass();
			});
			a.postMessage("origin-check");
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-name-property",
		js: `
			const channel = "ramjet-bc-name-" + Date.now() + "-" + Math.random();
			const bc = new BroadcastChannel(channel);
			assertEqual(bc.name, channel, "BC name should equal constructor arg");
			bc.close();
		`,
	}),

	basicTest({
		name: "broadcastchannel-sender-does-not-self-receive",
		js: `
			// Per BC spec, the sending BroadcastChannel instance does not
			// dispatch the message back to itself. The proxy must not break this.
			const channel = "ramjet-bc-self-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			let selfReceived = false;
			a.addEventListener("message", () => {
				selfReceived = true;
			});
			a.postMessage("self?");
			setTimeout(() => {
				assert(!selfReceived, "sender BC should not receive its own message");
				a.close();
				pass();
			}, 200);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-different-channels-isolated",
		js: `
			const nameA = "ramjet-bc-isoA-" + Date.now() + "-" + Math.random();
			const nameB = "ramjet-bc-isoB-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(nameA);
			const b = new BroadcastChannel(nameB);
			let bGot = false;
			b.addEventListener("message", () => {
				bGot = true;
			});
			a.postMessage("only on A");
			setTimeout(() => {
				assert(!bGot, "channel B should not receive a message sent on channel A");
				a.close();
				b.close();
				pass();
			}, 200);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-multiple-listeners",
		js: `
			const channel = "ramjet-bc-multi-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			const c = new BroadcastChannel(channel);
			let bCount = 0;
			let cCount = 0;
			b.addEventListener("message", (event) => {
				bCount++;
				assertEqual(event.data, "fanout", "b should receive unwrapped 'fanout'");
			});
			c.addEventListener("message", (event) => {
				cCount++;
				assertEqual(event.data, "fanout", "c should receive unwrapped 'fanout'");
			});
			a.postMessage("fanout");
			setTimeout(() => {
				assertEqual(bCount, 1, "b should have received exactly one message");
				assertEqual(cCount, 1, "c should have received exactly one message");
				a.close();
				b.close();
				c.close();
				pass();
			}, 200);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-closed-does-not-receive",
		js: `
			const channel = "ramjet-bc-closed-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			let bGot = false;
			b.addEventListener("message", () => {
				bGot = true;
			});
			b.close();
			a.postMessage("after-close");
			setTimeout(() => {
				assert(!bGot, "closed BC should not receive messages");
				a.close();
				pass();
			}, 200);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-primitives-roundtrip",
		js: `
			const channel = "ramjet-bc-primitives-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			const sent = [42, true, false, null];
			const received = [];
			b.addEventListener("message", (event) => {
				received.push(event.data);
				if (received.length === sent.length) {
					assertEqual(received[0], 42, "number should round-trip");
					assertEqual(received[1], true, "true should round-trip");
					assertEqual(received[2], false, "false should round-trip");
					assertEqual(received[3], null, "null should round-trip");
					a.close();
					b.close();
					pass();
				}
			});
			for (const v of sent) a.postMessage(v);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-array-roundtrip",
		js: `
			const channel = "ramjet-bc-array-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assert(Array.isArray(event.data), "data should be an array");
				assertEqual(event.data.length, 3, "array length should be 3");
				assertEqual(event.data[0], 1, "array[0]");
				assertEqual(event.data[1], "x", "array[1]");
				assertEqual(event.data[2], null, "array[2]");
				assert(!("$ramjet$data" in event.data), "$ramjet$data should not appear on the array");
				a.close();
				b.close();
				pass();
			});
			a.postMessage([1, "x", null]);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-nested-object-roundtrip",
		js: `
			const channel = "ramjet-bc-nested-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(event.data.outer.inner.value, "deep", "nested value should round-trip");
				assert(!("$ramjet$data" in event.data), "envelope must not leak at top level");
				assert(!("$ramjet$data" in event.data.outer), "envelope must not appear nested");
				a.close();
				b.close();
				pass();
			});
			a.postMessage({ outer: { inner: { value: "deep" } } });
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-removeeventlistener",
		js: `
			const channel = "ramjet-bc-remove-" + Date.now() + "-" + Math.random();
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			let calls = 0;
			const handler = () => { calls++; };
			b.addEventListener("message", handler);
			b.removeEventListener("message", handler);
			a.postMessage("should-not-fire");
			setTimeout(() => {
				assertEqual(calls, 0, "removed listener should not be invoked");
				a.close();
				b.close();
				pass();
			}, 200);
		`,
		autoPass: false,
	}),

	basicTest({
		name: "broadcastchannel-event-origin-matches-document",

		hostname: "broadcastchannel-test.example",
		js: `
			const channel = "ramjet-bc-origin-fake";
			const a = new BroadcastChannel(channel);
			const b = new BroadcastChannel(channel);
			b.addEventListener("message", (event) => {
				assertEqual(
					event.origin,
					"https://broadcastchannel-test.example",
					"event.origin should equal the proxied document origin"
				);
				a.close();
				b.close();
				pass();
			});
			a.postMessage("origin-check");
		`,
		autoPass: false,
	}),

	multiFrameTest({
		name: "broadcastchannel-cross-origin-isolated",

		root: {
			js: () => `
				const bc = new BroadcastChannel("ramjet-bc-xorigin");
				let leaked = false;
				bc.addEventListener("message", (event) => {
					leaked = true;
				});
				setTimeout(() => {
					bc.close();
					if (leaked) {
						fail("cross-origin BroadcastChannel message leaked into root frame");
					} else {
						pass();
					}
				}, 600);
			`,
			subframes: [
				{
					originid: "cross",
					id: "child",
					js: () => `
						// Wait for the root to install its listener, then post
						// from a different origin. The root must not receive it.
						setTimeout(() => {
							const bc = new BroadcastChannel("ramjet-bc-xorigin");
							bc.postMessage("should-not-cross");
							bc.close();
						}, 100);
					`,
				},
			],
		},
	}),

	multiFrameTest({
		name: "broadcastchannel-multi-frame-same-origin",
		root: {
			js: () => `
				const bc = new BroadcastChannel("ramjet-bc-mframe");
				bc.addEventListener("message", (event) => {
					assertEqual(event.data, "from-child", "parent should receive unwrapped child message");
					assert(
						typeof event.data !== "object" || !("$ramjet$data" in event.data),
						"envelope must not leak across frames"
					);
					bc.close();
					pass();
				});
			`,
			subframes: [
				{
					id: "child",
					js: () => `
						// Give the parent's frame script a tick to install its listener.
						setTimeout(() => {
							const bc = new BroadcastChannel("ramjet-bc-mframe");
							bc.postMessage("from-child");
							bc.close();
						}, 100);
					`,
				},
			],
		},
	}),
];

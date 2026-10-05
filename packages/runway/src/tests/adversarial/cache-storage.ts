import { basicTest } from "../../testcommon.ts";

export default [
	basicTest({
		name: "cachestorage-put-and-match",
		js: `
			const c = await caches.open("adversarial-cache");
			await c.put("/cached", new Response("cachedbody", { headers: { "Content-Type": "text/plain" } }));
			const m = await c.match("/cached");
			assert(m, "match found the entry");
			assertEqual(await m.text(), "cachedbody", "cached body");
			assertEqual(m.headers.get("content-type"), "text/plain", "cached headers");
			assertEqual((await c.keys()).length, 1, "one entry");
			assertEqual(await caches.has("adversarial-cache"), true, "caches.has");
			assertEqual(await c.delete("/cached"), true, "cache.delete(request)");
			assertEqual(await c.match("/cached"), undefined, "gone after delete");
			await caches.delete("adversarial-cache");
			assertEqual(await caches.has("adversarial-cache"), false, "caches.delete");
		`,
	}),
	basicTest({
		name: "cachestorage-put-fetched-response",
		js: `
			const c = await caches.open("adversarial-cache2");
			await c.put("/script.js", (await fetch("/script.js")).clone());
			const m = await c.match("/script.js");
			assert(m, "a fetched response can be cached");
			assertEqual(m.url, location.origin + "/script.js", "the cached Response.url is the site's");
			assert(!m.url.includes("/~/sj/"), "no proxy URL in the cached response");
			assert((await m.text()).length > 0, "the cached body is readable");
			await caches.delete("adversarial-cache2");
		`,
	}),

	basicTest({
		// ("http://site@name" instead of "name"). The standard activate-time

		name: "cachestorage-keys-not-namespaced",
		js: `
			const c = await caches.open("adversarial-cache3");
			const names = await caches.keys();
			assert(names.includes("adversarial-cache3"), "own cache is listed under its own name: " + JSON.stringify(names));
			assert(!names.some((n) => n.includes("ramjet")), "no proxy-internal caches listed: " + JSON.stringify(names));
			assert(!names.some((n) => n.includes("http")), "no namespaced names: " + JSON.stringify(names));
			await caches.delete("adversarial-cache3");
		`,
	}),
	basicTest({
		name: "cachestorage-request-keys-urls",
		js: `
			const c = await caches.open("adversarial-cache4");
			await c.put("/cached", new Response("x"));
			const keys = await c.keys();
			assertEqual(keys[0].url, location.origin + "/cached", "the cache Request key URL is the site's");
			assert(!keys[0].url.includes(":4500"), "no proxy origin in the cache key: " + keys[0].url);
			await caches.delete("adversarial-cache4");
		`,
	}),
	basicTest({
		name: "cachestorage-add-and-addall",
		js: `
			const c = await caches.open("adversarial-cache5");
			let addErr;
			try { await c.add("/script.js"); } catch (e) { addErr = e; }
			assert(!addErr, "cache.add must work: " + (addErr && addErr.message));
			let allErr;
			try { await c.addAll(["/script.js"]); } catch (e) { allErr = e; }
			assert(!allErr, "cache.addAll must work: " + (allErr && allErr.message));
			assert(await c.match("/script.js"), "the added entry is retrievable");
			await caches.delete("adversarial-cache5");
		`,
	}),
];

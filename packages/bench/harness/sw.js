importScripts("/controller/controller.sw.js");

const controller =
	self["$ramjetController"] ?? self["$" + "scram" + "jet" + "Controller"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
addEventListener("fetch", (e) => {
	if (controller.shouldRoute(e)) {
		e.respondWith(controller.route(e));
	}
});

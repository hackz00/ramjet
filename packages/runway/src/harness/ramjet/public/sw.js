importScripts("/controller/controller.sw.js");

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

addEventListener("fetch", (e) => {
	if ($ramjetController.shouldRoute(e)) {
		e.respondWith($ramjetController.route(e));
	}
});

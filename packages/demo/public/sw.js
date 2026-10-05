importScripts("/controller/controller.sw.js");

addEventListener("fetch", (e) => {
	if ($ramjetController.shouldRoute(e)) {
		e.respondWith($ramjetController.route(e));
	}
});

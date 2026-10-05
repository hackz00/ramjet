import { serverTest } from "../../testcommon.ts";

export default [
	serverTest({
		name: "originisolation-cross-site-frame-access",
		hostname: "a.example",
		cleartextHosts: ["b.example"],
		autoPass: true,
		js: `
			// --- what works today ---
			assertEqual(location.hostname, "a.example", "the page believes it is a.example");
			assertEqual(location.origin, "https://a.example", "and reports that origin");
			assertEqual(window.origin, location.origin, "window.origin agrees");
			document.cookie = "acookie=avalue; Path=/";
			await new Promise((r) => setTimeout(r, 400));
			const j = await (await fetch("https://b.example/echo", { credentials: "include" })).json();
			assertEqual(j.host, "b.example", "the cross-site request really reached b.example");
			assert(!String(j.cookie || "").includes("acookie"),
				"a.example's cookie must not be sent to b.example: " + JSON.stringify(j.cookie));

			// --- what does not ---
			const f = document.createElement("iframe");
			f.src = "https://b.example/frame.html";
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			const probe = (fn) => { try { return fn(); } catch { return "BLOCKED"; } };
			const doc = probe(() => f.contentDocument);

			assertEqual(doc === null || doc === "BLOCKED", true,
				"contentDocument of a cross-site frame must not be reachable");
			assertEqual(probe(() => f.contentDocument.getElementById("secret").textContent), "BLOCKED",
				"the other site's DOM must not be readable");
			assertEqual(probe(() => f.contentDocument.cookie), "BLOCKED",
				"the other site's cookies must not be readable - note the same cookie is correctly " +
				"withheld from cross-site requests above");
			assertEqual(probe(() => f.contentWindow.location.href), "BLOCKED",
				"the other site's location must not be readable");
			assertEqual(probe(() => f.contentWindow.origin), "BLOCKED",
				"the other site's origin must not be readable");
		`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (path === "/frame.html") {
					res.writeHead(200, {
						"Content-Type": "text/html",
						"Set-Cookie": "bsecret=bvalue; Path=/",
					});
					res.end(
						'<!DOCTYPE html><html><body><p id="secret">B-SIDE-SECRET</p></body></html>',
					);
					return;
				}
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "https://a.example",
					"Access-Control-Allow-Credentials": "true",
				});
				res.end(
					JSON.stringify({
						host: req.headers.host,
						cookie: req.headers.cookie ?? null,
					}),
				);
			});
		},
	}),
];

import { serverTest } from "../testcommon.ts";

const TEST_HELPERS = `
function emitBinding(name, payload) {
	var fn = globalThis[name];
	if (typeof fn === 'function') {
		fn(JSON.stringify(payload));
	}
}
function pass(message, details) {
	emitBinding('__testPass', { message: message, details: details });
}
function fail(message, details) {
	emitBinding('__testFail', { message: message, details: details });
}
function assertConsistent(label, value) {
	if (typeof value === 'undefined') {
		value = label;
		label = 'default';
	}
	emitBinding('__testConsistent', { label: label, value: value });
	return Promise.resolve();
}
function assert(condition, message) {
	if (!condition) { fail(message || 'Assertion failed'); throw new Error(message || 'Assertion failed'); }
}
function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		var msg = message || ('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
		fail(msg, { actual: actual, expected: expected });
		throw new Error(msg);
	}
}
var assertEquals = assertEqual;
function waitForTestFunctions(timeout) {
	timeout = timeout || 5000;
	return new Promise(function(resolve, reject) {
		var start = Date.now();
		function check() {
			if (typeof __testPass === 'function' && typeof __testFail === 'function') resolve();
			else if (Date.now() - start > timeout) reject(new Error('Timed out'));
			else setTimeout(check, 10);
		}
		check();
	});
}
async function runTest(testFn) {
	try { await waitForTestFunctions(); await testFn(); pass(); } catch (err) { fail(err.message); }
}
`;

function encodingTest(opts: {
	name: string;

	html: Buffer;

	contentType: string;

	assertion: string;
}) {
	return serverTest({
		name: opts.name,

		start: async (server, _port) => {
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": opts.contentType });
					res.end(opts.html);
				} else if (req.url === "/common.js") {
					res.writeHead(200, {
						"Content-Type": "application/javascript; charset=utf-8",
					});
					res.end(TEST_HELPERS);
				} else if (req.url === "/script.js") {
					res.writeHead(200, {
						"Content-Type": "application/javascript; charset=utf-8",
					});
					res.end(`runTest(async () => {\n${opts.assertion}\n});`);
				} else {
					res.writeHead(404);
					res.end("Not found");
				}
			});
		},
	});
}

function htmlPage(bodyContent: string): string {
	return `<!DOCTYPE html><html><head><script src="/common.js"></script></head><body>${bodyContent}<script src="/script.js"></script></body></html>`;
}

export default [
	encodingTest({
		name: "encoding-content-type-header-charset",
		contentType: "text/html; charset=utf-8",
		html: Buffer.from(htmlPage('<span id="test">café</span>'), "utf-8"),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "café", "Content-Type charset=utf-8 should decode correctly");
		`,
	}),

	encodingTest({
		name: "encoding-content-type-quoted-charset",
		contentType: 'text/html; charset="utf-8"',
		html: Buffer.from(htmlPage('<span id="test">naïve</span>'), "utf-8"),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "naïve", "Quoted charset should work");
		`,
	}),

	encodingTest({
		name: "encoding-utf8-bom-priority",

		contentType: "text/html; charset=iso-8859-1",
		html: Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from(htmlPage('<span id="test">Ünïcödé</span>'), "utf-8"),
		]),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "Ünïcödé", "UTF-8 BOM should override Content-Type");
		`,
	}),

	encodingTest({
		name: "encoding-meta-charset-tag",
		contentType: "text/html",
		html: Buffer.from(
			'<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/common.js"></script></head><body><span id="test">café</span><script src="/script.js"></script></body></html>',
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "café", "meta charset should be used when no header charset");
		`,
	}),

	encodingTest({
		name: "encoding-meta-http-equiv-content-type",
		contentType: "text/html",
		html: Buffer.from(
			'<!DOCTYPE html><html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"><script src="/common.js"></script></head><body><span id="test">café</span><script src="/script.js"></script></body></html>',
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "café", "meta http-equiv content-type charset should work");
		`,
	}),

	encodingTest({
		name: "encoding-default-utf8",
		contentType: "text/html",
		html: Buffer.from(htmlPage('<span id="test">hello</span>'), "utf-8"),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "hello", "Default UTF-8 should work for ASCII content");
		`,
	}),

	encodingTest({
		name: "encoding-latin1-content-type",
		contentType: "text/html; charset=iso-8859-1",

		html: Buffer.from(
			'<!DOCTYPE html><html><head><script src="/common.js"></script></head><body><span id="test">caf\xe9</span><script src="/script.js"></script></body></html>',
			"latin1",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "caf\\u00e9", "latin1 charset should decode correctly");
		`,
	}),

	encodingTest({
		name: "encoding-content-type-extra-params",
		contentType: "text/html; boundary=something; charset=utf-8",
		html: Buffer.from(htmlPage('<span id="test">résumé</span>'), "utf-8"),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "résumé", "charset after other params should work");
		`,
	}),

	encodingTest({
		name: "encoding-meta-charset-case-insensitive",
		contentType: "text/html",
		html: Buffer.from(
			'<!DOCTYPE html><html><head><META CHARSET="UTF-8"><script src="/common.js"></script></head><body><span id="test">tëst</span><script src="/script.js"></script></body></html>',
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "tëst", "meta charset should be case-insensitive");
		`,
	}),

	encodingTest({
		name: "encoding-meta-charset-utf16-becomes-utf8",
		contentType: "text/html",
		html: Buffer.from(
			'<!DOCTYPE html><html><head><meta charset="utf-16"><script src="/common.js"></script></head><body><span id="test">hello</span><script src="/script.js"></script></body></html>',
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "hello", "meta charset=utf-16 in prescan should be treated as utf-8");
		`,
	}),

	encodingTest({
		name: "encoding-utf16le-bom",
		contentType: "text/html",
		html: Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(htmlPage('<span id="test">hi</span>'), "utf16le"),
		]),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "hi", "UTF-16LE BOM should decode UTF-16LE content");
		`,
	}),

	encodingTest({
		name: "encoding-ascii-label-maps-to-windows-1252",
		contentType: "text/html; charset=ascii",

		html: Buffer.from(
			'<!DOCTYPE html><html><head><script src="/common.js"></script></head><body><span id="test">\x93hi\x94</span><script src="/script.js"></script></body></html>',
			"latin1",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "\\u201chi\\u201d", "ascii label should map to windows-1252");
		`,
	}),

	encodingTest({
		name: "encoding-content-type-whitespace-label",
		contentType: "text/html; charset= utf-8 ",
		html: Buffer.from(htmlPage('<span id="test">café</span>'), "utf-8"),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "café", "whitespace-padded charset label should still work");
		`,
	}),

	encodingTest({
		name: "encoding-meta-charset-after-1024-bytes-ignored",
		contentType: "text/html",
		html: Buffer.from(
			`<!DOCTYPE html><html><head><!-- ${"x".repeat(1100)} --><meta charset="windows-1251"><script src="/common.js"></script></head><body><span id="test">ok</span><script src="/script.js"></script></body></html>`,
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "ok", "late meta charset should be ignored by prescan");
		`,
	}),

	encodingTest({
		name: "encoding-utf16be-bom",
		contentType: "text/html",
		html: Buffer.concat([
			Buffer.from([0xfe, 0xff]),

			(() => {
				const str = htmlPage('<span id="test">be</span>');
				const buf = Buffer.alloc(str.length * 2);
				for (let i = 0; i < str.length; i++) {
					buf[i * 2] = 0;
					buf[i * 2 + 1] = str.charCodeAt(i);
				}
				return buf;
			})(),
		]),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "be", "UTF-16BE BOM should decode UTF-16BE content");
		`,
	}),

	encodingTest({
		name: "encoding-windows-1252-smart-quotes",
		contentType: "text/html; charset=windows-1252",

		html: Buffer.from(
			'<!DOCTYPE html><html><head><script src="/common.js"></script></head><body><span id="test">\x91hello\x92 \x96 world</span><script src="/script.js"></script></body></html>',
			"latin1",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "\\u2018hello\\u2019 \\u2013 world", "windows-1252 smart quotes and dash should decode correctly");
		`,
	}),

	encodingTest({
		name: "encoding-header-overrides-meta",
		contentType: "text/html; charset=utf-8",

		html: Buffer.from(
			'<!DOCTYPE html><html><head><meta charset="windows-1251"><script src="/common.js"></script></head><body><span id="test">héllo</span><script src="/script.js"></script></body></html>',
			"utf-8",
		),
		assertion: `
			const el = document.getElementById("test");
			assertEqual(el.textContent, "héllo", "Content-Type header should override meta charset");
		`,
	}),
];

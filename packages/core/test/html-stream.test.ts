import { describe, expect, it } from "vitest";
import { DomHandler } from "domhandler";
import { StreamingHtmlRewriter } from "@rewriters/html-stream";
import { context, htmlcontext, newMeta, reference, script, streamed } from "./html-fixtures";

const many = Array.from({ length: 150 }, (_, i) => `<p class="c${i}">para ${i} &amp; <a href="/p/${i}?x=1&y=2">link ${i}</a> <img src="/i/${i}.png"></p>`).join("\n");

const corpus: Record<string, string> = {
	"plain document": `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/a.css"></head><body><a href="/x">x &amp; y</a><img src=a.png srcset="a.png 1x, b.png 2x"></body></html>`,
	"no head": `<html><body>hi <b>there</b></body></html>`,
	"doctype comment before html": `<!DOCTYPE html><!-- c --><html lang="en"><head></head><body></body></html>`,
	"quirky: no html element": `<div>hi</div><p>x`,
	"quirky: element directly in html": `<html><div>x</div></html>`,
	"html without children": `<html></html>`,
	"text only": `just some text`,
	"comments and text inside html before head": `<html>\n<!--a-->\n<head><meta charset="utf-8"></head>\n<body>b</body></html>`,
	"body first with leading comment": `<html><!--c--> <body>x</body></html>`,
	"entities and attribute forms": `<html><head></head><body title="a &quot;q&quot; &amp; b" data-x='single' data-y=unquoted disabled data-z="" TITLE="dup"><input disabled checked><p>&lt;tag&gt; &nbsp; &copy; &#169; &#x1F600; é 😀</p></body></html>`,
	"uppercase tags and attributes": `<HTML><HEAD></HEAD><BODY CLASS="A" onClick="location.href='/x'"><A HREF="/Y">Y</A></BODY></HTML>`,
	"void and self-closing forms": `<html><head><meta charset=utf-8><base href="/b/"></head><body><br/><hr><img src="x.png"/><a href="rel">r</a><link rel=icon href=/f.ico></body></html>`,
	"base href changes later urls": `<html><head><a href="before">b</a><base href="/other/"><a href="after">a</a></head><body><a href="x">x</a></body></html>`,
	"inline script with html comment": `<html><head></head><body><script><!-- var a = location.href; --></script><script>var b = top;</script></body></html>`,
	"module script, importmap, json": `<html><head><script type="importmap">{"imports":{"a":"/a.js"}}</script><script type="module">import x from "./x.js"; x(location)</script><script type="application/json">{"a":"</b>"}</script></head><body></body></html>`,
	"script variants": `<html><head><script></script><script> </script><script src="/s.js" defer></script><script>if (a < b && c > d) { document.write("<b>x</b>") }</script></head><body></body></html>`,
	"inline style and style attribute": `<html><head><style>.a{background:url(bg.png)} @import "x.css";</style></head><body style="background:url('/y.png')"><div style=""></div></body></html>`,
	"event handlers": `<html><body><button onclick="location.href='/x'" onmouseover="top.foo()">b</button><a href="javascript:location=1">j</a></body></html>`,
	"meta csp and refresh": `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta http-equiv="refresh" content="5; url=/next"><meta name="x" content="y"></head><body></body></html>`,
	"svg and math foreign content": `<html><body><svg viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"><circle cx="1"/><clipPath id=a></clipPath><foreignObject><div>x &amp; y</div></foreignObject><use xlink:href="#a"/><style>.a{b:c}</style></svg><math><mi>x</mi><annotation-xml encoding="x"><b>y</b></annotation-xml></math></body></html>`,
	"cdata, processing instruction, comments": `<html><body><![CDATA[ x < y ]]><?php echo 1 ?><!-- a --><!---->x<!-- b -- c --></body></html>`,
	"raw text elements": `<html><body><textarea>a &amp; <b></textarea><title>t &lt; u</title><noscript><img src=n.png></noscript><iframe src="/f">x &amp;</iframe><pre>\n a\n</pre><template><b>t</b></template></body></html>`,
	"unclosed and misnested": `<html><body><p>a<p>b<div><span>c<div>d</body>`,
	"anchors in tables and lists": `<html><body><table><tr><td><a href="/t">t</a><tr><td>b</table><ul><li><a href="/l">l<li>m</ul></body></html>`,
	"srcset, picture, forms": `<html><body><picture><source srcset="a.webp 1x, b.webp 2x"><img src="c.png" srcset="c.png 1x"></picture><form action="/go" method=post><input type=image src="/sub.png"><button formaction="/x">b</button></form></body></html>`,
	"integrity and sandbox": `<html><head><link rel=stylesheet href=/c.css integrity="sha256-abc" crossorigin><script src=/j.js integrity="sha256-x"></script></head><body><iframe src="/i" sandbox="allow-scripts"></iframe></body></html>`,
	"non-ascii": `<html><head><meta charset=utf-8><title>日本語 – ünïcödé 😀</title></head><body>日本語 😀 &euro; <a href="/é?q=ü">é</a></body></html>`,
	"truncated mid-tag": `<html><body><p>hi <a href="/x`,
	"truncated inside a script": `<html><body><p>a</p><script>var a = location.href;`,
	"truncated inside a comment": `<html><body><p>a</p><!-- unfinished`,
	"truncated inside a style": `<html><head><style>.a{background:url(x.png)`,
	"document.write building markup": `<html><body><script>document.write("<scr" + "ipt>top.x()</scr" + "ipt>"); document.write('<a href="/w">w</a>')</script><p>after</p></body></html>`,
	"escaped closing script tag in a string": `<html><body><script>var s = "<\\/script>"; location.href = s;</script><p>after</p></body></html>`,
	"style with a script-looking string": `<html><head><style>.a:after{content:"</scr" "ipt>"}</style></head><body></body></html>`,
	"two bodies and stray end tags": `<html><body>a</body></div></p><body>b</body></html></html>`,
	"many elements":`<html><head><title>m</title></head><body>${many}</body></html>`,
	"whitespace and newlines": `\n\n<!doctype html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body>\n    <p>a</p>\n  </body>\n</html>\n\n`,
};

describe("StreamingHtmlRewriter matches rewriteHtml byte for byte", () => {
	const chunks = [1, 2, 3, 7, 64, 1000, 1_000_000];
	for (const [name, html] of Object.entries(corpus)) {
		it(name, () => {
			const expected = reference(html);
			for (const chunk of chunks) {
				expect(streamed(html, chunk), `${name} @ chunk ${chunk}`).toBe(expected);
			}
		});
	}
});

describe("StreamingHtmlRewriter streaming behavior", () => {
	it("emits the head before the body has arrived", () => {
		const meta = newMeta();
		const rewriter = new StreamingHtmlRewriter(context, meta, htmlcontext, () =>
			context.interface.getInjectScripts(meta, new DomHandler(), htmlcontext, script)
		);
		const first = rewriter.write(`<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/a.css"></head><body><p>start`);
		expect(first).toContain("<title>t</title>");
		expect(first).toContain('rel="stylesheet"');
		expect(first).toContain("ramjet-injected");
		expect(first).toContain("<p>start");
		const rest = rewriter.write(`</p></body></html>`) + rewriter.end();
		expect(first + rest).toBe(reference(`<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/a.css"></head><body><p>start</p></body></html>`));
	});

	it("holds an inline script until it closes, and nothing else", () => {
		const meta = newMeta();
		const rewriter = new StreamingHtmlRewriter(context, meta, htmlcontext, null);
		expect(rewriter.write("<p>a</p><script>var x = ")).toBe("<p>a</p>");
		expect(rewriter.write("top;</script><p>b</p>")).toContain("<p>b</p>");
	});

	it("does not inject anything when no scripts are requested", () => {
		const rewriter = new StreamingHtmlRewriter(context, newMeta(), htmlcontext, null);
		expect(rewriter.write("<html><body>x</body></html>") + rewriter.end()).toBe("<html><body>x</body></html>");
	});

	it("rejects writes after end", () => {
		const rewriter = new StreamingHtmlRewriter(context, newMeta(), htmlcontext, null);
		rewriter.end();
		expect(() => rewriter.write("x")).toThrow();
		expect(rewriter.end()).toBe("");
	});
});

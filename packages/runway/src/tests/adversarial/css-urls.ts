import { basicTest } from "../../testcommon.ts";

export default [
	basicTest({
		name: "cssurls-setattribute-roundtrip",
		js: `
			const d = document.createElement("div");
			d.setAttribute("style", "background-image: url(/bg.png)");
			assertEqual(d.getAttribute("style"), "background-image: url(/bg.png)", "style attribute round trip");
			assert(!d.outerHTML.includes("/~/sj/"), "outerHTML: " + d.outerHTML);
		`,
	}),
	basicTest({
		name: "cssurls-parsed-markup-roundtrip",
		js: `
			const d = document.createElement("div");
			d.innerHTML = '<div style="background-image: url(/bg.png)"></div>';
			assertEqual(d.innerHTML, '<div style="background-image: url(/bg.png)"></div>', "innerHTML round trip");
			assert(!d.innerHTML.includes("/~/sj/"), "no proxy URL in innerHTML");
		`,
	}),
	basicTest({
		name: "cssurls-stylesheet-csstext",
		js: `
			const st = document.createElement("style");
			st.textContent = ".a { background-image: url(/x.png); }";
			document.head.appendChild(st);
			assert(!st.sheet.cssRules[0].cssText.includes("/~/sj/"),
				"cssRules[0].cssText leaks the proxy URL: " + st.sheet.cssRules[0].cssText);
			st.sheet.insertRule(".b { background-image: url(/y.png); }", 1);
			assertEqual(st.sheet.cssRules.length, 2, "insertRule");
			assert(!st.sheet.cssRules[1].cssText.includes("/~/sj/"),
				"inserted rule cssText leaks: " + st.sheet.cssRules[1].cssText);
			assert(!st.textContent.includes("/~/sj/"), "textContent leaks the proxy URL: " + st.textContent);
		`,
	}),
	basicTest({
		name: "cssurls-non-url-properties",
		js: `
			const d = document.createElement("div");
			d.style.color = "red";
			d.style.top = "5px";
			d.style.setProperty("--custom", "12px");
			assertEqual(d.style.color, "red", "color");
			assertEqual(d.style.top, "5px", "top");
			assertEqual(d.style.getPropertyValue("--custom"), "12px", "custom property");
			assertEqual(d.getAttribute("style"), "color: red; top: 5px; --custom: 12px;", "style attribute");
			assertEqual(d.style.length, 3, "style.length");
			d.style.removeProperty("color");
			assertEqual(d.style.color, "", "removeProperty");
		`,
	}),

	basicTest({
		name: "cssurls-cssom-write-serialization",
		js: `
			const d = document.createElement("div");
			d.style.backgroundImage = "url(/bg.png)";
			assert(!d.outerHTML.includes("/~/sj/"), "outerHTML must not expose the proxy URL: " + d.outerHTML);
			assertEqual(d.getAttribute("style"), 'background-image: url("/bg.png");', "style attribute");
			const c = document.createElement("div");
			c.style.cssText = "background-image: url(/bg.png)";
			assert(!c.outerHTML.includes("/~/sj/"), "cssText write: " + c.outerHTML);
		`,
	}),
	basicTest({
		name: "cssurls-computed-style",
		js: `
			const d = document.createElement("div");
			d.style.backgroundImage = "url(/bg.png)";
			document.body.appendChild(d);
			const c = getComputedStyle(d).backgroundImage;
			assert(!c.includes("/~/sj/"), "computed style leaks the proxy URL: " + c);
			assertEqual(c, 'url("' + location.origin + '/bg.png")', "computed style resolves to the real URL");
		`,
	}),
	basicTest({
		name: "cssurls-cssrule-style-property",
		js: `
			const st = document.createElement("style");
			st.textContent = ".a { background-image: url(/x.png); }";
			document.head.appendChild(st);
			const rule = st.sheet.cssRules[0];
			assertEqual(rule.style.backgroundImage, 'url("/x.png")', "rule.style.backgroundImage");
			assertEqual(rule.style.getPropertyValue("background-image"), 'url("/x.png")', "getPropertyValue");
		`,
	}),
	basicTest({
		name: "cssurls-author-string-preserved",
		js: `
			const a = document.createElement("div");
			a.style.backgroundImage = "url(/bg.png)";
			assertEqual(a.style.backgroundImage, 'url("/bg.png")', "after a CSSOM write");
			const b = document.createElement("div");
			b.setAttribute("style", "background-image: url(/bg.png)");
			assertEqual(b.style.backgroundImage, 'url("/bg.png")', "after a setAttribute write");
			const c = document.createElement("div");
			c.innerHTML = '<div style="background-image: url(/bg.png)"></div>';
			assertEqual(c.firstChild.style.backgroundImage, 'url("/bg.png")', "after parsing markup");
			const st = document.createElement("style");
			st.textContent = ".a { background-image: url(/x.png); }";
			document.head.appendChild(st);
			assertEqual(st.textContent, ".a { background-image: url(/x.png); }", "style textContent round trip");
		`,
	}),
];

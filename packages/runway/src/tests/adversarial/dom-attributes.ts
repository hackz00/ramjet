import { basicTest } from "../../testcommon.ts";

export default [
	basicTest({
		name: "domattr-names-and-serialization",
		js: `
			const img = document.createElement("img");
			img.src = "/a.png";
			img.className = "c";
			assertDeepEqual(img.getAttributeNames().sort(), ["class", "src"], "getAttributeNames");
			assertEqual(img.outerHTML, '<img src="/a.png" class="c">', "outerHTML");
			assertEqual(img.getAttribute("src"), "/a.png", "getAttribute");
			assert(img.hasAttribute("src"), "hasAttribute");
			assert(!img.hasAttribute("ramjet-attr-src"), "no internal attribute is reachable by name");
			img.removeAttribute("src");
			assertEqual(img.getAttribute("src"), null, "removeAttribute");
			assertDeepEqual(img.getAttributeNames(), ["class"], "names after removal");
		`,
	}),
	basicTest({
		name: "domattr-clonenode",
		js: `
			const img = document.createElement("img");
			img.src = "/a.png";
			const c = img.cloneNode(true);
			assertEqual(c.getAttribute("src"), "/a.png", "cloned attribute");
			assertEqual(c.src, location.origin + "/a.png", "cloned property");
			assertEqual(c.outerHTML, '<img src="/a.png">', "cloned outerHTML");
			const d = document.createElement("div");
			d.innerHTML = '<a href="/x">y</a>';
			assertEqual(d.cloneNode(true).innerHTML, '<a href="/x">y</a>', "cloned subtree");
			assertEqual(d.cloneNode(true).querySelector("a").href, location.origin + "/x", "cloned subtree property");
		`,
	}),
	basicTest({
		name: "domattr-dataset-classlist",
		js: `
			const d = document.createElement("div");
			d.dataset.fooBar = "1";
			assertEqual(d.getAttribute("data-foo-bar"), "1", "dataset write");
			assertEqual(d.dataset.fooBar, "1", "dataset read");
			d.classList.add("a", "b");
			assertEqual(d.className, "a b", "classList");
			assert(d.classList.contains("a"), "contains");
			assertEqual(d.outerHTML, '<div data-foo-bar="1" class="a b"></div>', "outerHTML");
		`,
	}),
	basicTest({
		name: "domattr-collections",
		js: `
			document.body.innerHTML = '<a href="/l1">a</a><img src="/i1.png"><form action="/f1"></form>';
			assert(document.links.length >= 1, "document.links");
			assertEqual(document.links[0].href, location.origin + "/l1", "links href");
			assertEqual(document.images[0].src, location.origin + "/i1.png", "images src");
			assertEqual(document.forms[0].action, location.origin + "/f1", "forms action");
			assertEqual(document.querySelectorAll("[src]").length, 1, "presence selector");
		`,
	}),
	basicTest({
		name: "domattr-customelements",
		js: `
			const calls = [];
			class MyEl extends HTMLElement {
				static get observedAttributes() { return ["src", "data-x"]; }
				constructor() { super(); calls.push("ctor"); }
				connectedCallback() { calls.push("connected"); }
				attributeChangedCallback(n, o, v) { calls.push("attr:" + n + ":" + o + ":" + v); }
			}
			customElements.define("my-el-adversarial", MyEl);
			const el = new MyEl();
			el.setAttribute("data-x", "1");
			document.body.appendChild(el);
			await new Promise((r) => setTimeout(r, 50));
			assert(calls.includes("ctor"), "constructor ran");
			assert(calls.includes("connected"), "connectedCallback ran");
			assert(calls.includes("attr:data-x:null:1"), "attributeChangedCallback: " + JSON.stringify(calls));
			assert(el instanceof MyEl, "instanceof");
			assert(el instanceof HTMLElement, "instanceof HTMLElement");
			assertEqual(document.querySelector("my-el-adversarial"), el, "queryable by tag name");
		`,
	}),
	basicTest({
		name: "domattr-shadow-root-basics",
		js: `
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = host.attachShadow({ mode: "open" });
			assertEqual(host.shadowRoot, root, "shadowRoot");
			const img = document.createElement("img");
			img.src = "/s2.png";
			root.appendChild(img);
			assertEqual(img.src, location.origin + "/s2.png", "an element created then appended into a shadow root");
			root.innerHTML += "<slot></slot>";
			const light = document.createElement("span");
			host.appendChild(light);
			assertEqual(root.querySelector("slot").assignedNodes().length, 1, "slot assignment");
		`,
	}),

	basicTest({
		name: "domattr-attributes-namednodemap",
		js: `
			const img = document.createElement("img");
			img.src = "/a.png";
			img.className = "c";
			assertDeepEqual([...img.attributes].map((a) => a.name).sort(), ["class", "src"], "attributes");
			assertEqual(img.attributes.length, 2, "attributes.length");
			assertEqual(img.attributes.src.value, "/a.png", "attribute node value");
			assertEqual(img.attributes.getNamedItem("src").value, "/a.png", "getNamedItem");
		`,
	}),
	basicTest({
		name: "domattr-mutationobserver-records",
		js: `
			const img = document.createElement("img");
			document.body.appendChild(img);
			const records = [];
			const mo = new MutationObserver((rs) => records.push(...rs));
			mo.observe(img, { attributes: true, attributeOldValue: true });
			img.src = "/a.png";
			await new Promise((r) => setTimeout(r, 100));
			mo.disconnect();
			assertEqual(records.length, 1,
				"exactly one mutation record, got " + JSON.stringify(records.map((r) => r.attributeName)));
			assertEqual(records[0].attributeName, "src", "attributeName");
			assertEqual(records[0].oldValue, null, "oldValue");
		`,
	}),
	basicTest({
		name: "domattr-selector-literal-value",
		js: `
			document.body.innerHTML = '<a href="/l1">a</a><img src="/i1.png">';
			assert(document.querySelector('[href="/l1"]') !== null, "attribute selector on href");
			assert(document.querySelector('[src="/i1.png"]') !== null, "attribute selector on src");
			assert(document.querySelector('a[href^="/l"]') !== null, "prefix attribute selector");
		`,
	}),
	basicTest({
		name: "domattr-integrity-property",
		js: `
			const s = document.createElement("script");
			s.src = "/x.js";
			s.integrity = "sha384-abc";
			s.crossOrigin = "anonymous";
			assertEqual(s.crossOrigin, "anonymous", "crossOrigin round trip");
			assertEqual(s.integrity, "sha384-abc", "integrity round trip");
			assertEqual(s.getAttribute("integrity"), "sha384-abc", "integrity attribute");
		`,
	}),
	basicTest({
		name: "domattr-shadow-innerhtml-urls",
		js: `
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = host.attachShadow({ mode: "open" });
			root.innerHTML = '<img src="/s.png"><a href="/l">x</a>';
			assertEqual(root.querySelector("img").src, location.origin + "/s.png", "img.src in a shadow root");
			assertEqual(root.querySelector("a").href, location.origin + "/l", "a.href in a shadow root");
			assertEqual(root.querySelector("img").getAttribute("src"), "/s.png", "attribute in a shadow root");
		`,
	}),
];

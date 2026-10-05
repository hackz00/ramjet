import { Parser } from "htmlparser2";
import { DomHandler, Element, Text } from "domhandler";
import render from "dom-serializer";
import type { RamjetContext } from "@/shared";
import { Tap } from "@/Tap";
import type { URLMeta } from "@rewriters/url";
import {
	rewriteElementAttributes,
	rewriteElementContent,
	rewriteMetaElement,
	type HtmlContext,
} from "@rewriters/html";

type RenderOpts = {
	encodeEntities: "utf8";
	decodeEntities: false;
	xmlMode?: boolean | "foreign";
};

const FOREIGN_INTEGRATION_POINTS = new Set([
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
	"annotation-xml",
	"foreignObject",
	"desc",
	"title",
]);
const FOREIGN_ROOTS = new Set(["svg", "math"]);

const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"basefont",
	"br",
	"col",
	"command",
	"embed",
	"frame",
	"hr",
	"img",
	"input",
	"isindex",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

type ParentRef = { name: string } | null;
type Pseudo = {
	name: string;
	attribs: Record<string, string>;
	children: { data: string }[];
};

type Frame = {
	rendered: string;

	inner: RenderOpts;
	closeTag: string;

	pendingGt: boolean;

	dropped?: boolean;

	buffered?: { node: Pseudo; text: string[] };
};

export type InjectScripts = () => Element[];

export class StreamingHtmlRewriter {
	private readonly parser: Parser;
	private readonly stack: Frame[] = [];
	private out = "";

	private held: string | null;
	private htmlOpenEnd = -1;
	private sawRootElement = false;
	private commentOpen = false;
	private cdataOpen = false;
	private ended = false;

	private readonly context: RamjetContext;
	private readonly meta: URLMeta;
	private readonly htmlcontext: HtmlContext;
	private readonly injectScripts: InjectScripts | null;

	constructor(
		context: RamjetContext,
		meta: URLMeta,
		htmlcontext: HtmlContext,
		injectScripts: InjectScripts | null,
	) {
		this.context = context;
		this.meta = meta;
		this.htmlcontext = htmlcontext;
		this.injectScripts = injectScripts;
		this.held = injectScripts ? "" : null;
		this.parser = new Parser(
			{
				onopentag: (name, attribs) => this.onOpen(name, attribs),
				onclosetag: (name) => this.onClose(name),
				ontext: (data) => this.onText(data),
				oncomment: (data) => this.onComment(data),
				oncommentend: () => this.onCommentEnd(),
				oncdatastart: () => {
					this.cdataOpen = true;
					this.emit("<![CDATA[");
				},
				oncdataend: () => {
					this.cdataOpen = false;
					this.emit("]]>");
				},
				onprocessinginstruction: (_name, data) => this.emit(`<${data}>`),
			},
			{ startingForeignContext: htmlcontext.foreignContext },
		);
	}

	write(chunk: string): string {
		if (this.ended) throw new Error("StreamingHtmlRewriter already ended");
		this.parser.write(chunk);
		return this.take();
	}

	end(): string {
		if (this.ended) return "";
		this.ended = true;
		this.parser.end();
		if (this.held !== null) this.decide("end");
		return this.take();
	}

	private take(): string {
		const out = this.out;
		this.out = "";
		return out;
	}

	private baseOpts(): RenderOpts {
		return {
			encodeEntities: "utf8",
			decodeEntities: false,
			xmlMode: this.htmlcontext.foreignContext ? "foreign" : undefined,
		};
	}

	private parentOpts(): RenderOpts {
		return this.stack[this.stack.length - 1]?.inner ?? this.baseOpts();
	}

	private parentRef(): ParentRef {
		const top = this.stack[this.stack.length - 1];
		return top ? { name: top.rendered } : null;
	}

	private serialize(node: Element | Text, opts: RenderOpts): string {
		return render(node as never, opts as never);
	}

	private emit(text: string): void {
		const top = this.stack[this.stack.length - 1];
		if (top?.pendingGt) {
			top.pendingGt = false;
			text = ">" + text;
		}
		if (this.held !== null) this.held += text;
		else this.out += text;
	}

	private decide(
		mode: "head" | "body-first" | "quirky" | "end",
		pending = "",
	): void {
		const held = this.held;
		if (held === null) return;
		this.held = null;
		const scripts = this.injectScripts
			? render(
					this.injectScripts() as never,
					{ encodeEntities: "utf8", decodeEntities: false } as never,
				)
			: "";
		const withHead = (at: number) =>
			held.slice(0, at) + "<head>" + scripts + "</head>" + held.slice(at);
		switch (mode) {
			case "head":
				this.out += held + scripts;
				break;
			case "body-first":
				this.out += withHead(this.htmlOpenEnd) + pending;
				break;
			case "quirky":
				this.out += scripts + held + pending;
				break;
			case "end":
				this.out +=
					this.htmlOpenEnd >= 0 ? withHead(this.htmlOpenEnd) : scripts + held;
				break;
		}
	}

	private place(name: string, text: string): void {
		if (this.held === null) return this.emit(text);

		if (this.stack.length === 0 && !this.sawRootElement) {
			this.sawRootElement = true;
			if (name.toLowerCase() !== "html") {
				this.decide("quirky", text);
				return;
			}
			this.emit(text);
			this.htmlOpenEnd = this.held.length;
			return;
		}

		const parent = this.stack[this.stack.length - 1];
		if (
			this.htmlOpenEnd >= 0 &&
			this.stack.length === 1 &&
			parent?.rendered.toLowerCase() === "html"
		) {
			const lower = name.toLowerCase();
			if (lower === "head") {
				this.emit(text);
				this.decide("head");
			} else if (lower === "body") {
				this.decide("body-first", text);
			} else {
				this.decide("quirky", text);
			}
			return;
		}
		this.emit(text);
	}

	private onOpen(name: string, attribs: Record<string, string>): void {
		const node: Pseudo = { name, attribs, children: [] };
		rewriteElementAttributes(node, this.context, this.meta);

		if (name === "meta") {
			const replacement = rewriteMetaElement(node, this.context, this.meta);
			if (replacement) {
				this.emit("<!--" + String(replacement.data) + "-->");
				this.stack.push({
					rendered: name,
					inner: this.parentOpts(),
					closeTag: "",
					pendingGt: false,
					dropped: true,
				});
				return;
			}
		}

		if (name === "script" || name === "style") {
			this.stack.push({
				rendered: name,
				inner: this.parentOpts(),
				closeTag: "",
				pendingGt: false,
				buffered: { node, text: [] },
			});
			return;
		}

		const parentOpts = this.parentOpts();
		const parent = this.parentRef();

		const probe = new Element(name, node.attribs, []);
		(probe as unknown as { parent: ParentRef }).parent = parent;
		const empty = this.serialize(probe, parentOpts);
		const rendered = /^<([^\s>/]+)/.exec(empty)?.[1] ?? name;
		let inner = parentOpts;
		if (
			inner.xmlMode === "foreign" &&
			parent &&
			FOREIGN_INTEGRATION_POINTS.has(parent.name)
		) {
			inner = { ...inner, xmlMode: false };
		}
		if (!inner.xmlMode && FOREIGN_ROOTS.has(rendered))
			inner = { ...inner, xmlMode: "foreign" };

		const isVoid = !inner.xmlMode && VOID_ELEMENTS.has(name);
		const closeTag = isVoid ? "" : `</${rendered}>`;
		const withChild = new Element(name, node.attribs, [new Text("") as never]);
		(withChild as unknown as { parent: ParentRef }).parent = parent;
		const full = this.serialize(withChild, parentOpts);
		const open = isVoid ? full : full.slice(0, full.length - closeTag.length);

		const pendingGt = !!inner.xmlMode && empty.endsWith("/>");
		this.place(name, pendingGt ? open.slice(0, -1) : open);
		this.stack.push({ rendered, inner, closeTag, pendingGt });
	}

	private onClose(_name: string): void {
		const frame = this.stack.pop();
		if (!frame || frame.dropped) return;

		if (frame.buffered) {
			const { node, text } = frame.buffered;
			if (text.length) node.children = [{ data: text.join("") }];
			rewriteElementContent(node as never, this.context, this.meta);

			const element = new Element(node.name, node.attribs, []);
			(element as unknown as { parent: ParentRef }).parent = this.parentRef();
			if (node.children.length) {
				const child = new Text(node.children[0].data);
				(child as unknown as { parent: unknown }).parent = element;
				element.children.push(child as never);
			}
			this.place(node.name, this.serialize(element, this.parentOpts()));
			return;
		}

		this.emitClose(frame.pendingGt ? "/>" : frame.closeTag);
	}

	private emitClose(text: string): void {
		if (this.held !== null) this.held += text;
		else this.out += text;
	}

	private onText(data: string): void {
		const top = this.stack[this.stack.length - 1];
		if (top?.buffered) {
			top.buffered.text.push(data);
			return;
		}
		if (this.cdataOpen) return this.emit(data);
		const node = new Text(data);
		(node as unknown as { parent: ParentRef }).parent = this.parentRef();
		this.emit(this.serialize(node, this.parentOpts()));
	}

	private onComment(data: string): void {
		if (!this.commentOpen) {
			this.commentOpen = true;
			this.emit("<!--");
		}
		this.emit(data);
	}

	private onCommentEnd(): void {
		if (!this.commentOpen) return;
		this.commentOpen = false;
		this.emit("-->");
	}
}

export function createStreamingRewriter(
	context: RamjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext,
): StreamingHtmlRewriter | null {
	const hooks = context.hooks?.rewriter.html;
	if (hooks && (Tap.hasListeners(hooks.pre) || Tap.hasListeners(hooks.post)))
		return null;

	const script = (src: string) =>
		new Element("script", { src, "ramjet-injected": "true" });
	const inject: InjectScripts | null = htmlcontext.loadScripts
		? () =>
				context.interface.getInjectScripts(
					meta,
					new DomHandler(),
					htmlcontext,
					script,
				)
		: null;
	return new StreamingHtmlRewriter(context, meta, htmlcontext, inject);
}

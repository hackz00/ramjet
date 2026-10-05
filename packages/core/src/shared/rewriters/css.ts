import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { RamjetContext } from "@/shared";
import { String } from "@/shared/snapshot";
import { noteCssResource, type CssUrlKind } from "@rewriters/hints";

export function rewriteCss(css: string, context: RamjetContext, meta: URLMeta) {
	return handleCss("rewrite", css, context, meta);
}

export function unrewriteCss(css: string, context: RamjetContext) {
	return handleCss("unrewrite", css, context);
}

function inFontFace(css: string, offset: number): boolean {
	const open = css.lastIndexOf("{", offset);
	if (open < 0) return false;
	const start =
		Math.max(css.lastIndexOf("}", open), css.lastIndexOf(";", open)) + 1;
	return css
		.slice(start, open)
		.trimStart()
		.toLowerCase()
		.startsWith("@font-face");
}

const IMPORT_BEFORE = /@import\s*$/i;

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: RamjetContext,
	meta?: URLMeta,
) {
	// regex from vk6 (https://github.com/ading2210)
	const urlRegex =
		/(?i:url)\((?:\s*"((?:\\.|[^"])+)"\s*|\s*'((?:\\.|[^'])+)'\s*|((?!\s*['"])(?!\s*\))(?:\\.|[^)])+?))\)/gm;
	const Atruleregex =
		/@import\s+((?i:url)\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;
	css = String(css);
	css = css.replace(
		urlRegex,
		(
			match,
			doubleQuotedUrl: string | undefined,
			singleQuotedUrl: string | undefined,
			unquotedUrl: string | undefined,
			offset: number,
		) => {
			const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl;
			const encodedUrl =
				type === "rewrite"
					? rewriteUrl(url.trim(), context, meta!)
					: unrewriteUrl(url.trim(), context);

			if (type === "rewrite") {
				const kind: CssUrlKind = IMPORT_BEFORE.test(
					css.slice(Math.max(0, offset - 16), offset),
				)
					? "import"
					: inFontFace(css, offset)
						? "font"
						: "image";
				noteCssResource(encodedUrl, kind);
			}

			return match.replace(url, encodedUrl);
		},
	);
	css = css.replace(Atruleregex, (match, importStatement: string) => {
		return match.replace(
			importStatement,
			importStatement.replace(
				/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
				(match: string, firstQuote: string, url: string, endQuote: string) => {
					if (firstQuote.startsWith("url")) {
						return match;
					}
					const encodedUrl =
						type === "rewrite"
							? rewriteUrl(url.trim(), context, meta!)
							: unrewriteUrl(url.trim(), context);
					if (type === "rewrite") noteCssResource(encodedUrl, "import");

					return `${firstQuote}${encodedUrl}${endQuote}`;
				},
			),
		);
	});

	return css;
}

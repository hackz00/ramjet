import { basicTest } from "../../testcommon.ts";

export default [
	basicTest({
		name: "shadowing-let-const",
		js: `
			{
				let location = 1, top = 2, parent = 3;
				assertEqual(location, 1, "let location");
				assertEqual(top, 2, "let top");
				assertEqual(parent, 3, "let parent");
			}
			{
				const location = "c";
				assertEqual(location, "c", "const location");
			}
			assertEqual((function () { let location = 6; return location; })(), 6, "let inside a function");
		`,
	}),
	basicTest({
		name: "shadowing-params",
		js: `
			assertEqual((function (location) { return location; })(5), 5, "parameter named location");
			assertEqual((function (top, parent) { return top + parent; })(1, 2), 3, "parameters named top/parent");
			assertEqual(((location) => location)("arrow"), "arrow", "arrow parameter");
			assertEqual((function ({ location }) { return location; })({ location: 9 }), 9, "destructured parameter");
			assertEqual((function (location = 4) { return location; })(), 4, "default parameter");
			assertEqual((function (...location) { return location.length; })(1, 2), 2, "rest parameter");
		`,
	}),
	basicTest({
		name: "shadowing-catch-and-function-decl",
		js: `
			assertEqual((function () { try { throw 5; } catch (location) { return location; } })(), 5, "catch parameter");
			assertEqual((function () { function location() { return "fn"; } return location(); })(), "fn", "function declaration named location");
			assertEqual((function () { class location {} return typeof location; })(), "function", "class declaration named location");
		`,
	}),
	basicTest({
		name: "shadowing-var-top-parent",
		js: `
			assertEqual((function () { var top = 6; return top; })(), 6, "var top");
			assertEqual((function () { var parent = 7; return parent; })(), 7, "var parent");
			assertEqual((function () { var eval = 8; return eval; })(), 8, "var eval");
			assertEqual(new Function("var top = 6; return top")(), 6, "var top inside a Function body");
		`,
	}),

	basicTest({
		name: "shadowing-var-location",
		js: `
			assertEqual((function () { var location = 6; return location; })(), 6, "var location in a function");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-must-not-navigate",
		js: `
			const before = location.href;
			(function () { var location = "#hijacked"; })();
			await new Promise((r) => setTimeout(r, 300));
			assertEqual(location.href, before, "a local var named location must not navigate the page");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-declare-then-assign",
		js: `
			assertEqual((function () { var location; location = 6; return location; })(), 6, "declare then assign");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-multi-declarator",
		js: `
			assertEqual((function () { var a = 1, location = 6; return location; })(), 6, "second declarator in a var statement");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-nested-block",
		js: `
			assertEqual((function () { { var location = 6; } return location; })(), 6, "var location declared in a nested block");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-arrow",
		js: `
			assertEqual((() => { var location = 6; return location; })(), 6, "var location in an arrow function");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-closure",
		js: `
			assertEqual((function () {
				var location = 6;
				return (function () { return location; })();
			})(), 6, "a nested closure reads the outer var");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-for-loop",
		js: `
			assertEqual((function () {
				var out;
				for (var location = 0; location < 3; location++) out = location;
				return out;
			})(), 2, "var location as a loop counter");
		`,
	}),
	basicTest({
		name: "shadowing-var-location-function-ctor",
		js: `
			assertEqual(new Function("var location = 6; return location")(), 6, "var location inside a Function body");
		`,
	}),
];

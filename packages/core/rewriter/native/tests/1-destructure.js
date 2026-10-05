{
	const { location: x } = globalThis;
	check(x);
}
{
	let { location: x } = globalThis;
	check(x);
}
{
	var { location: x } = globalThis;
	check(x);
}

{
	const { location } = globalThis;
	check(location);
	const { eval } = globalThis;
	check(eval);
}

{
	const {
		g: { eval },
	} = { g: globalThis };
	check(eval);

	const {
		g: {
			r: { location },
		},
	} = { g: { r: globalThis } };
	check(location);
}

{
	const { ...rest } = globalThis;
	check(rest.location);
	check(rest.top);
	check(rest.eval);
}

{
	var { g: location } = { g: "j" };
}
{
	var { location } = { location: "j" };
}
{
	var { ...location } = {
		toString() {
			return "j";
		},
	};
}

{
	const prop = "eval";
	const { [prop]: x } = globalThis;
	check(x);
}

{
	const { eval } = globalThis,
		{ location } = globalThis;
	check(eval);
	check(location);
}

{
	const obj = { g: globalThis };
	const {
		g: { ["loc" + "ation"]: x, ["ev" + "al"]: y },
	} = obj;
	check(x);
	check(y);
}

{
	const key1 = "g";
	const key2 = "eval";
	const wrapper = { g: globalThis };
	const {
		[key1]: { [key2]: x },
	} = wrapper;
	check(x);
}

{
	function getGlobals() {
		const { eval, location } = globalThis;
		return { e: eval, l: location };
	}
	const { e, l } = getGlobals();
	check(e);
	check(l);
}

{
	const prop1 = "eval";
	const prop2 = "location";
	const { [prop1]: x, [prop2]: y } = globalThis;
	check(x);
	check(y);
}

for (const { location, eval } of [globalThis]) {
	check(location);
	check(eval);
}

(function ({ eval, location }) {
	check(eval);
	check(location);
})(globalThis);

try {
	throw globalThis;
} catch ({ eval, location }) {
	check(eval);
	check(location);
}

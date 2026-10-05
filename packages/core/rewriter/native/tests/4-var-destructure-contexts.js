for (var { location } = { location: "j" }; false; ) {}
check(location);

for (var { location } of [{ location: "j" }]) {
	check(location);
}

for (var { location } in { whatever: 1 }) {
	check(location);
}

let sideEffectRan = false;
function sideEffect() {
	sideEffectRan = true;
	return { location: "j" };
}
if (false) var { location } = sideEffect();
if (sideEffectRan) fail();
check(location);

{
	var { location } = { location: "j" };
	check(location);
}

loop: var { location } = { location: "j" };
check(location);

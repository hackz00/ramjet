import { RamjetClient } from "@client/index";
import { Object_defineProperty, Symbol_for } from "@/shared/snapshot";

export const POLLUTANT = Symbol_for("ramjet realm pollutant");

export default function (client: RamjetClient, self: GlobalThis) {
	Object_defineProperty(self.Object.prototype, "$ramjet$setrealmfn", {
		value(pollution: object) {
			Object_defineProperty(this, POLLUTANT, {
				value: pollution,
				writable: false,
				configurable: true,
				enumerable: false,
			});

			return this;
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

import { RamjetClient } from "@client/index";

export default function (client: RamjetClient, _self: Self) {
	client.Trap("origin", {
		get() {
			return client.url.origin;
		},
		set() {
			return false;
		},
	});
}

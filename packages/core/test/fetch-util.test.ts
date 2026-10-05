import { describe, expect, it } from "vitest";
import { isRedirect } from "../src/fetch/util";

const res = (status: number) =>
	({ status }) as Parameters<typeof isRedirect>[0];

describe("isRedirect", () => {
	it("is true for the statuses a browser follows through Location", () => {
		for (const status of [301, 302, 303, 307, 308])
			expect(isRedirect(res(status)), String(status)).toBe(true);
	});

	it("is false for 304 Not Modified and other non-redirect statuses", () => {
		for (const status of [200, 204, 206, 300, 304, 305, 400, 404, 500])
			expect(isRedirect(res(status)), String(status)).toBe(false);
	});
});

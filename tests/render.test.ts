/**
 * MCP results are shaped by the server, so the extraction has to survive both
 * the wrapped envelopes Render returns and a plain list.
 */
import { describe, expect, it } from "vitest";
import {
	findDeploys,
	findLogMessages,
	findServiceUrl,
	parseToolText,
	serviceRecords,
} from "../app/render.js";

/**
 * Paginated tools append their cursor after the JSON. A strict parse fails, the
 * payload degrades to a string, and every finder silently returns nothing —
 * which once cost a run a 15-minute deploy timeout on a deploy that went live
 * in 13 seconds.
 */
describe("parseToolText", () => {
	const listDeploys =
		'[{"id":"dep-dadelk1t0dsc7389veo0","status":"live","trigger":"blueprint_sync"}]\n\n cursor: Tfgyh_mGGfZsazF0MGRzYzczODl2ZW8w';

	it("parses a payload with a cursor line appended", () => {
		expect(parseToolText(listDeploys)).toEqual([
			{
				id: "dep-dadelk1t0dsc7389veo0",
				status: "live",
				trigger: "blueprint_sync",
			},
		]);
	});

	it("keeps the deploy visible to findDeploys", () => {
		expect(findDeploys(parseToolText(listDeploys))).toEqual([
			{ id: "dep-dadelk1t0dsc7389veo0", status: "live" },
		]);
	});

	it("parses clean JSON unchanged", () => {
		expect(parseToolText('{"ok":true}')).toEqual({ ok: true });
	});

	it("returns null for text carrying no JSON", () => {
		expect(parseToolText("service srv-1: unauthorized")).toBeNull();
		expect(parseToolText("")).toBeNull();
	});

	it("returns null rather than half a value when the JSON is truncated", () => {
		expect(parseToolText('[{"id":"dep-1","status":"li')).toBeNull();
	});
});

describe("serviceRecords", () => {
	it("reads services out of a cursor-wrapped list", () => {
		const payload = [
			{
				service: {
					id: "srv-abc123",
					name: "airo-demo-shop-web",
					serviceDetails: { url: "https://airo-demo-shop-web.onrender.com" },
				},
				cursor: "c1",
			},
		];

		expect(serviceRecords(payload)).toEqual([
			{
				id: "srv-abc123",
				name: "airo-demo-shop-web",
				url: "https://airo-demo-shop-web.onrender.com",
			},
		]);
	});

	it("reads a service returned bare, and tolerates a missing URL", () => {
		expect(serviceRecords({ id: "srv-xyz", name: "airo-demo-shop-api" })).toEqual(
			[{ id: "srv-xyz", name: "airo-demo-shop-api", url: null }],
		);
	});

	it("ignores objects that are not services", () => {
		expect(serviceRecords({ id: "dep-1", status: "live" })).toEqual([]);
	});
});

describe("findServiceUrl", () => {
	it("strips a trailing slash so smoke URLs concatenate cleanly", () => {
		expect(findServiceUrl({ url: "https://x-web.onrender.com/" })).toBe(
			"https://x-web.onrender.com",
		);
	});

	it("ignores URLs that are not Render service URLs", () => {
		expect(findServiceUrl({ url: "https://github.com/acme/apps" })).toBeNull();
	});
});

describe("findDeploys", () => {
	it("reads deploy status from a wrapped list", () => {
		const payload = [
			{ deploy: { id: "dep-1", status: "build_failed" }, cursor: "c" },
		];
		expect(findDeploys(payload)).toEqual([
			{ id: "dep-1", status: "build_failed" },
		]);
	});
});

describe("findLogMessages", () => {
	// Render returns logs newest first; a build log reads correctly oldest first.
	it("reverses log order", () => {
		const payload = {
			logs: [{ message: "error: exit 1" }, { message: "running npm install" }],
		};
		expect(findLogMessages(payload)).toEqual([
			"running npm install",
			"error: exit 1",
		]);
	});
});

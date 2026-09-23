/**
 * MCP results are shaped by the server, so the extraction has to survive both
 * the wrapped envelopes Render returns and a plain list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeployRecord,
	findBlueprint,
	findDeploys,
	findLogMessages,
	findServiceUrl,
	pageContains,
	pageScripts,
	parseToolText,
	type RenderMcp,
	serviceRecords,
	waitForDeploy,
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
					name: "vibe-demo-shop-web",
					serviceDetails: { url: "https://vibe-demo-shop-web.onrender.com" },
				},
				cursor: "c1",
			},
		];

		expect(serviceRecords(payload)).toEqual([
			{
				id: "srv-abc123",
				name: "vibe-demo-shop-web",
				url: "https://vibe-demo-shop-web.onrender.com",
			},
		]);
	});

	it("reads a service returned bare, and tolerates a missing URL", () => {
		expect(serviceRecords({ id: "srv-xyz", name: "vibe-demo-shop-api" })).toEqual(
			[{ id: "srv-xyz", name: "vibe-demo-shop-api", url: null }],
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

/**
 * Right after a push, the newest deploy is still the deploy from before the
 * push. A repair round once took that failed deploy as its own result, so it
 * never saw the deploy of its repair.
 */
describe("waitForDeploy", () => {
	const FAILED: DeployRecord = { id: "dep-1", status: "pre_deploy_failed" };

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Each list_deploys call returns the next deploy, then the last again. */
	function renderReturns(...deploys: DeployRecord[]) {
		let calls = 0;
		const callTool = vi.fn(async () => [
			deploys[Math.min(calls++, deploys.length - 1)],
		]);
		return { mcp: { callTool } as unknown as RenderMcp, callTool };
	}

	/** Wait 60 seconds for the API, and run the sleeps between polls at once. */
	async function waitForApi(
		mcp: RenderMcp,
		opts: { after?: string; onPoll?: (detail: string) => void } = {},
	) {
		const [outcome] = await Promise.all([
			waitForDeploy(mcp, "srv-api", {
				workspaceId: "tea-test",
				timeoutMs: 60_000,
				...opts,
			}),
			vi.runAllTimersAsync(),
		]);
		return outcome;
	}

	it("returns the newest deploy when it is terminal", async () => {
		const { mcp, callTool } = renderReturns(FAILED);

		expect(await waitForApi(mcp)).toEqual({
			deployId: "dep-1",
			status: "pre_deploy_failed",
			result: "failed",
		});
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledWith("list_deploys", {
			serviceId: "srv-api",
			limit: 1,
			workspaceId: "tea-test",
		});
	});

	it("polls past the deploy from before the push", async () => {
		const { mcp, callTool } = renderReturns(
			FAILED,
			{ id: "dep-2", status: "build_in_progress" },
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi(mcp, { after: "dep-1" })).toEqual({
			deployId: "dep-2",
			status: "live",
			result: "live",
		});
		expect(callTool).toHaveBeenCalledTimes(3);
	});

	// A deploy from before the push is never a result of the push, not even a
	// live one.
	it.each(["pre_deploy_failed", "live"])(
		"reports not_started when the %s deploy from before the push stays the newest",
		async (status) => {
			const onPoll = vi.fn();
			const { mcp, callTool } = renderReturns({ id: "dep-1", status });

			expect(await waitForApi(mcp, { after: "dep-1", onPoll })).toEqual({
				deployId: "dep-1",
				status,
				result: "not_started",
			});
			// One poll each 5 seconds until the deadline, and not more.
			expect(callTool).toHaveBeenCalledTimes(12);
			expect(onPoll).toHaveBeenLastCalledWith(
				"Service srv-api: waiting for a deploy after dep-1",
			);
		},
	);

	it("times out while the newer deploy is in progress", async () => {
		const { mcp } = renderReturns(FAILED, {
			id: "dep-2",
			status: "build_in_progress",
		});

		expect(await waitForApi(mcp, { after: "dep-1" })).toEqual({
			deployId: "dep-2",
			status: "timed out while build_in_progress",
			result: "timed_out",
		});
	});
});

const PAGE = "https://vibe-demo-shop-web.onrender.com";
const API_HOST = "vibe-demo-shop-api.onrender.com";

describe("pageScripts", () => {
	it("finds the scripts that a Vite build loads", () => {
		const html = [
			'<script type="module" crossorigin src="/assets/index-B1x2.js"></script>',
			'<link rel="modulepreload" crossorigin href="/assets/vendor-C3y4.js">',
			'<link rel="stylesheet" crossorigin href="/assets/index-D5z6.css">',
		].join("\n");
		expect(pageScripts(html, PAGE)).toEqual([
			`${PAGE}/assets/index-B1x2.js`,
			`${PAGE}/assets/vendor-C3y4.js`,
		]);
	});

	it("reads single-quoted, unquoted, and relative references", () => {
		const html =
			"<script src='app.js' defer></script><SCRIPT SRC=/js/main.js></SCRIPT>";
		expect(pageScripts(html, PAGE)).toEqual([
			`${PAGE}/app.js`,
			`${PAGE}/js/main.js`,
		]);
	});

	// An agent wrote the page. Its references must not send the workflow to a
	// different host, on the internet or on the private network.
	it("never leaves the origin of the page", () => {
		const html = [
			'<script src="https://cdn.example.com/lib.js"></script>',
			'<script src="//evil.example/steal.js"></script>',
			'<script src="http://vibe-demo-shop-api-x7k2:10000/"></script>',
		].join("\n");
		expect(pageScripts(html, PAGE)).toEqual([]);
	});

	it("skips inline scripts and tags in comments", () => {
		const html =
			'<script>window.x = 1;</script><!-- <script src="/old.js"></script> -->';
		expect(pageScripts(html, PAGE)).toEqual([]);
	});
});

describe("pageContains", () => {
	const html = '<script type="module" src="/assets/index-B1x2.js"></script>';

	/** Serve these bodies by URL, and 404 for every other URL. */
	function serve(files: Record<string, string>) {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const body = files[String(url)];
			return body === undefined
				? new Response("not found", { status: 404 })
				: new Response(body);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("finds the API hostname in the bundle", async () => {
		serve({
			[PAGE]: html,
			[`${PAGE}/assets/index-B1x2.js`]: `const b="https://${API_HOST}";`,
		});
		expect(await pageContains(PAGE, API_HOST)).toBe(true);
	});

	// This is the failure that the check is for. `property: host` gives the
	// bundle a private-network name. All checks of the API pass, and every
	// browser fails.
	it("is false when the bundle has the private-network name", async () => {
		serve({
			[PAGE]: html,
			[`${PAGE}/assets/index-B1x2.js`]:
				'const b="https://vibe-demo-shop-api-x7k2";',
		});
		expect(await pageContains(PAGE, API_HOST)).toBe(false);
	});

	it("does not request a script from a different origin", async () => {
		const fetchMock = serve({
			[PAGE]: '<script src="https://cdn.example.com/lib.js"></script>',
		});
		expect(await pageContains(PAGE, API_HOST)).toBe(false);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([PAGE]);
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

describe("findBlueprint", () => {
	const target = {
		workspaceId: "tea-factory",
		repo: "https://github.com/acme/apps",
		branch: "main",
		path: "render.yaml",
	};
	const ours = {
		id: "exs-ours",
		name: "apps",
		status: "in_sync",
		autoSync: true,
		repo: "https://github.com/acme/apps",
		branch: "main",
		path: "render.yaml",
	};
	const other = (n: number) => ({
		blueprint: {
			...ours,
			id: `exs-other-${n}`,
			repo: `https://github.com/acme/other-${n}`,
		},
		cursor: `cursor-${n}`,
	});

	/** Serve these pages in order, and record each URL. */
	function servePages(pages: unknown[][]) {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				urls.push(new URL(String(url)));
				return Response.json(pages[urls.length - 1] ?? []);
			}),
		);
		return urls;
	}

	beforeEach(() => {
		vi.stubEnv("RENDER_API_KEY", "rnd_test");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	// An API key can see many workspaces. Before this, the lookup read one page
	// of all of them, and missed a Blueprint that was number 128 of 128.
	it("reads the factory workspace, and follows the cursor to a later page", async () => {
		const first = Array.from({ length: 100 }, (_, n) => other(n));
		const urls = servePages([
			first,
			[{ blueprint: ours, cursor: "cursor-ours" }],
		]);

		expect(await findBlueprint(target)).toEqual(ours);
		expect(urls.map((url) => url.searchParams.get("ownerId"))).toEqual([
			"tea-factory",
			"tea-factory",
		]);
		expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([
			null,
			"cursor-99",
		]);
	});

	it("stops after a short page", async () => {
		const urls = servePages([[other(1), other(2)]]);

		expect(await findBlueprint(target)).toBeNull();
		expect(urls).toHaveLength(1);
	});
});

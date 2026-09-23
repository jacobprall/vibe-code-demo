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
	McpError,
	pageContains,
	pageScripts,
	parseToolText,
	RenderMcp,
	serviceRecords,
	waitForDeploy,
	waitForServices,
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
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	/**
	 * Each list_deploys call returns the next deploy, or throws the next
	 * error. After the last one, each call does the last one again.
	 */
	function renderReturns(...results: (DeployRecord | Error)[]) {
		let calls = 0;
		const callTool = vi.fn(async () => {
			const result = results[Math.min(calls++, results.length - 1)];
			if (result instanceof Error) throw result;
			return [result];
		});
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

	/*
	 * A deploy wait can poll for 15 minutes, after the push. One failed poll
	 * once ended the run as "failed", although the deploy went live.
	 */
	it("polls again after a poll fails", async () => {
		const onPoll = vi.fn();
		const { mcp, callTool } = renderReturns(
			new McpError("Render MCP responded 502: Bad Gateway", { status: 502 }),
			new DOMException(
				"The operation was aborted due to timeout",
				"TimeoutError",
			),
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi(mcp, { onPoll })).toEqual({
			deployId: "dep-2",
			status: "live",
			result: "live",
		});
		expect(callTool).toHaveBeenCalledTimes(3);
		expect(onPoll.mock.calls.map(([detail]) => detail)).toEqual([
			"list_deploys for srv-api failed (attempt 1 of 5): Render MCP responded 502: Bad Gateway",
			"list_deploys for srv-api failed (attempt 2 of 5): The operation was aborted due to timeout",
		]);
	});

	it("counts only the failures in sequence", async () => {
		const failure = new McpError("Render MCP responded 503: ", { status: 503 });
		const failures = Array.from({ length: 4 }, () => failure);
		const { mcp } = renderReturns(
			...failures,
			{ id: "dep-2", status: "build_in_progress" },
			...failures,
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi(mcp)).toMatchObject({ result: "live" });
	});

	it("fails with the last error when 5 polls in sequence fail", async () => {
		const { mcp, callTool } = renderReturns(
			{ id: "dep-2", status: "build_in_progress" },
			...Array.from(
				{ length: 4 },
				() => new McpError("Render MCP responded 503: ", { status: 503 }),
			),
			new TypeError("fetch failed", { cause: new Error("other side closed") }),
		);

		await expect(waitForApi(mcp)).rejects.toThrow(
			"list_deploys for srv-api failed 5 times in sequence. " +
				"The last error: fetch failed: other side closed",
		);
		expect(callTool).toHaveBeenCalledTimes(6);
	});

	// A new attempt cannot repair the API key, so the wait does not continue
	// until its deadline.
	it.each([401, 403])("fails at once on a %i", async (status) => {
		const error = new McpError(`Render MCP responded ${status}: `, { status });
		const { mcp, callTool } = renderReturns(error);

		await expect(waitForApi(mcp)).rejects.toBe(error);
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	/**
	 * These tests use the real MCP client. A fake Render MCP server gives a
	 * new session to each initialize request, and `answer` can replace the
	 * answer to a request. `answer` must answer each tools/call request.
	 */
	describe("through the MCP client", () => {
		const LIVE: DeployRecord = { id: "dep-2", status: "live" };

		interface McpRequest {
			method: string;
			id: number;
			session: string | null;
			/** The number of requests with this method, this one included. */
			count: number;
		}

		function fakeMcpServer(answer: (request: McpRequest) => Response | null) {
			const requests: McpRequest[] = [];
			let sessions = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
					const { method, id } = JSON.parse(String(init?.body));
					const request: McpRequest = {
						method,
						id,
						session: new Headers(init?.headers).get("mcp-session-id"),
						count: requests.filter((r) => r.method === method).length + 1,
					};
					requests.push(request);

					const answered = answer(request);
					if (answered) return answered;
					if (method === "initialize") {
						sessions++;
						return Response.json(
							{ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18" } },
							{ headers: { "mcp-session-id": `session-${sessions}` } },
						);
					}
					if (method === "notifications/initialized") {
						return new Response(null, { status: 202 });
					}
					throw new Error(`No answer to ${method}`);
				}),
			);
			return requests;
		}

		/** The answer to a tools/call request, as the Render MCP server gives it. */
		function toolAnswer(id: number, result: object): Response {
			return Response.json({ jsonrpc: "2.0", id, result });
		}

		function deploys(id: number, deploy: DeployRecord): Response {
			return toolAnswer(id, {
				content: [
					{ type: "text", text: `${JSON.stringify([deploy])}\n\n cursor: ""` },
				],
			});
		}

		function newClient(): RenderMcp {
			return new RenderMcp("https://mcp.render.test/mcp", "rnd_test");
		}

		/* The server ends a session that is idle for 30 minutes, and a restart
		 * ends all sessions. A deploy repair can take longer than 30 minutes. */
		it("continues in a new session when the server ends the session", async () => {
			const requests = fakeMcpServer(({ method, id, session, count }) => {
				if (method !== "tools/call") return null;
				if (count === 1) {
					return deploys(id, { id: "dep-2", status: "build_in_progress" });
				}
				if (session === "session-1") {
					return new Response("Session terminated", { status: 404 });
				}
				return deploys(id, LIVE);
			});
			const onPoll = vi.fn();

			expect(await waitForApi(newClient(), { onPoll })).toMatchObject({
				result: "live",
			});
			expect(
				requests.map(({ method, session }) => `${method} ${session ?? "-"}`),
			).toEqual([
				"initialize -",
				"notifications/initialized session-1",
				"tools/call session-1",
				"tools/call session-1",
				"initialize -",
				"notifications/initialized session-2",
				"tools/call session-2",
			]);
			expect(onPoll).toHaveBeenCalledWith(
				"list_deploys for srv-api failed (attempt 1 of 5): Render MCP responded 404: Session terminated",
			);
		});

		it("does the handshake again after it fails", async () => {
			const requests = fakeMcpServer(({ method, id, count }) => {
				if (method === "initialize" && count === 1) {
					throw new TypeError("fetch failed", {
						cause: new Error("getaddrinfo ENOTFOUND mcp.render.test"),
					});
				}
				return method === "tools/call" ? deploys(id, LIVE) : null;
			});
			const onPoll = vi.fn();

			expect(await waitForApi(newClient(), { onPoll })).toMatchObject({
				result: "live",
			});
			expect(requests.map(({ method }) => method)).toEqual([
				"initialize",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
			expect(onPoll).toHaveBeenCalledWith(
				"list_deploys for srv-api failed (attempt 1 of 5): fetch failed: getaddrinfo ENOTFOUND mcp.render.test",
			);
		});

		/* The server sends an API key on to the Render API. So a key that is not
		 * valid fails in the tool call, and the MCP request gets a 200. */
		it.each([
			["service srv-api: unauthorized", 401],
			["cannot access workspace tea-test: forbidden", 403],
		])(
			"fails at once when the tool call fails with %s",
			async (text, status) => {
				const requests = fakeMcpServer(({ method, id }) =>
					method === "tools/call"
						? toolAnswer(id, {
								isError: true,
								content: [{ type: "text", text }],
							})
						: null,
				);

				await expect(waitForApi(newClient())).rejects.toMatchObject({
					name: "McpError",
					message: `list_deploys: ${text}`,
					status,
				});
				expect(
					requests.filter(({ method }) => method === "tools/call"),
				).toHaveLength(1);
			},
		);
	});
});

describe("waitForServices", () => {
	const web = { id: "srv-web", name: "acme-demo-shop-web" };
	const api = { id: "srv-api", name: "acme-demo-shop-api" };

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("polls again after a poll fails, until each service is there", async () => {
		const results = [
			[web],
			new McpError("list_services: received response code 503: ", {
				tool: "list_services",
			}),
			[web, api],
		];
		let calls = 0;
		const callTool = vi.fn(async () => {
			const result = results[calls++];
			if (result instanceof Error) throw result;
			return result;
		});
		const onPoll = vi.fn();

		const [services] = await Promise.all([
			waitForServices(
				{ callTool } as unknown as RenderMcp,
				"tea-test",
				[web.name, api.name],
				60_000,
				onPoll,
			),
			vi.runAllTimersAsync(),
		]);

		expect([...services.keys()]).toEqual([web.name, api.name]);
		expect(onPoll.mock.calls.map(([detail]) => detail)).toEqual([
			"Found 1/2 services",
			"list_services failed (attempt 1 of 5): list_services: received response code 503: ",
		]);
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

	/**
	 * Serve these pages in order, and record each URL. A Response in the list
	 * is the answer to its request.
	 */
	function servePages(pages: (unknown[] | Response)[]) {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				urls.push(new URL(String(url)));
				const page = pages[urls.length - 1] ?? [];
				return page instanceof Response ? page : Response.json(page);
			}),
		);
		return urls;
	}

	/** Look up the Blueprint, and do the waits between attempts at once. */
	async function lookUp() {
		vi.useFakeTimers();
		const [blueprint] = await Promise.all([
			findBlueprint(target),
			vi.runAllTimersAsync(),
		]);
		return blueprint;
	}

	beforeEach(() => {
		vi.stubEnv("RENDER_API_KEY", "rnd_test");
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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

	it("requests a page again after a request fails", async () => {
		const urls = servePages([
			new Response("upstream error", { status: 503 }),
			[{ blueprint: ours, cursor: "cursor-ours" }],
		]);

		expect(await lookUp()).toEqual(ours);
		expect(urls).toHaveLength(2);
	});

	// Null tells the run that no Blueprint exists, and the run then tells the
	// user to create one. A lookup that failed cannot know that.
	it("fails with the last error when 5 requests in sequence fail", async () => {
		const urls = servePages(
			Array.from({ length: 5 }, () => new Response("", { status: 500 })),
		);

		await expect(lookUp()).rejects.toThrow(
			"The Blueprint lookup failed 5 times in sequence. " +
				"The last error: Listing Blueprints failed with 500.",
		);
		expect(urls).toHaveLength(5);
	});

	it.each([401, 403])("fails at once on a %i", async (status) => {
		const urls = servePages([new Response("", { status })]);

		await expect(lookUp()).rejects.toThrow(
			`Listing Blueprints failed with ${status}. The API key needs read access to the workspace.`,
		);
		expect(urls).toHaveLength(1);
	});
});

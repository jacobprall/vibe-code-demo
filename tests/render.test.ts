/**
 * The Render reads of the workflow. No test calls the Render API: each test
 * replaces fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchDeployLogs,
	findBlueprint,
	pageContains,
	pageScripts,
	waitForDeploy,
	waitForServices,
	workflowIdOfTaskRun,
} from "../app/render.js";

const REST_API = "https://api.render.com/v1";

/** A deploy as the Render API lists it. */
interface Deploy {
	id: string;
	status: string;
}

/**
 * Right after a push, the newest deploy is still the deploy from before the
 * push. A repair round once took that failed deploy as its own result, so it
 * never saw the deploy of its repair.
 */
describe("waitForDeploy", () => {
	const FAILED: Deploy = { id: "dep-1", status: "pre_deploy_failed" };

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("RENDER_API_KEY", "rnd_test");
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	/**
	 * Each request gets the next deploy, or the next error status, or throws
	 * the next error. After the last one, each request gets the last one again.
	 */
	function renderReturns(...results: (Deploy | number | Error)[]) {
		let calls = 0;
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) => {
				const result = results[Math.min(calls++, results.length - 1)];
				if (result instanceof Error) throw result;
				if (typeof result === "number") {
					return new Response("", { status: result });
				}
				return Response.json([{ deploy: result, cursor: "c" }]);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	/** Wait 60 seconds for the API, and run the sleeps between polls at once. */
	async function waitForApi(
		opts: { after?: string; onPoll?: (detail: string) => void } = {},
	) {
		const [outcome] = await Promise.all([
			waitForDeploy("srv-api", { timeoutMs: 60_000, ...opts }),
			vi.runAllTimersAsync(),
		]);
		return outcome;
	}

	it("returns the newest deploy when it is terminal", async () => {
		const fetchMock = renderReturns(FAILED);

		expect(await waitForApi()).toEqual({
			deployId: "dep-1",
			status: "pre_deploy_failed",
			result: "failed",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`${REST_API}/services/srv-api/deploys?limit=1`);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer rnd_test",
		);
	});

	it("polls past the deploy from before the push", async () => {
		const fetchMock = renderReturns(
			FAILED,
			{ id: "dep-2", status: "build_in_progress" },
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi({ after: "dep-1" })).toEqual({
			deployId: "dep-2",
			status: "live",
			result: "live",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	// A deploy from before the push is never a result of the push, not even a
	// live one.
	it.each(["pre_deploy_failed", "live"])(
		"reports not_started when the %s deploy from before the push stays the newest",
		async (status) => {
			const onPoll = vi.fn();
			const fetchMock = renderReturns({ id: "dep-1", status });

			expect(await waitForApi({ after: "dep-1", onPoll })).toEqual({
				deployId: "dep-1",
				status,
				result: "not_started",
			});
			// One poll each 5 seconds until the deadline, and not more.
			expect(fetchMock).toHaveBeenCalledTimes(12);
			expect(onPoll).toHaveBeenLastCalledWith(
				"Service srv-api: waiting for a deploy after dep-1",
			);
		},
	);

	it("times out while the newer deploy is in progress", async () => {
		renderReturns(FAILED, { id: "dep-2", status: "build_in_progress" });

		expect(await waitForApi({ after: "dep-1" })).toEqual({
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
		const fetchMock = renderReturns(
			502,
			new DOMException("The operation was aborted due to timeout", "TimeoutError"),
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi({ onPoll })).toEqual({
			deployId: "dep-2",
			status: "live",
			result: "live",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(onPoll.mock.calls.map(([detail]) => detail)).toEqual([
			"The deploy lookup of srv-api failed (attempt 1 of 5): Listing the deploys of srv-api failed with 502.",
			"The deploy lookup of srv-api failed (attempt 2 of 5): The operation was aborted due to timeout",
		]);
	});

	it("counts only the failures in sequence", async () => {
		const failures = [503, 503, 503, 503];
		renderReturns(
			...failures,
			{ id: "dep-2", status: "build_in_progress" },
			...failures,
			{ id: "dep-2", status: "live" },
		);

		expect(await waitForApi()).toMatchObject({ result: "live" });
	});

	it("fails with the last error when 5 polls in sequence fail", async () => {
		const fetchMock = renderReturns(
			{ id: "dep-2", status: "build_in_progress" },
			503,
			503,
			503,
			503,
			new TypeError("fetch failed", { cause: new Error("other side closed") }),
		);

		await expect(waitForApi()).rejects.toThrow(
			"The deploy lookup of srv-api failed 5 times in sequence. " +
				"The last error: fetch failed: other side closed",
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	// A new attempt cannot repair the API key, so the wait does not continue
	// until its deadline.
	it.each([401, 403])("fails at once on a %i", async (status) => {
		const fetchMock = renderReturns(status);

		await expect(waitForApi()).rejects.toThrow(
			`Listing the deploys of srv-api failed with ${status}. The API key needs read access to the workspace.`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("waitForServices", () => {
	const web = {
		id: "srv-web",
		name: "acme-demo-shop-web",
		serviceDetails: { url: "https://acme-demo-shop-web.onrender.com/" },
	};
	const api = {
		id: "srv-api",
		name: "acme-demo-shop-api",
		serviceDetails: { url: "https://acme-demo-shop-api.onrender.com" },
	};

	/**
	 * Each request gets the next list of services, or the next error status.
	 * Returns the URL of each request.
	 */
	function serveServices(results: ((typeof web)[] | number)[]): URL[] {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				urls.push(new URL(String(url)));
				const result = results[Math.min(urls.length, results.length) - 1];
				return typeof result === "number"
					? new Response("", { status: result })
					: Response.json(result.map((service) => ({ service, cursor: "c" })));
			}),
		);
		return urls;
	}

	/** Wait 60 seconds for the services, and run the sleeps at once. */
	async function waitFor(names: string[], onPoll = vi.fn()) {
		const [services] = await Promise.all([
			waitForServices("tea-test", names, 60_000, onPoll),
			vi.runAllTimersAsync(),
		]);
		return services;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("RENDER_API_KEY", "rnd_test");
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("polls again after a poll fails, until each service is there", async () => {
		const urls = serveServices([[web], 503, [web, api]]);
		const onPoll = vi.fn();

		const services = await waitFor([web.name, api.name], onPoll);

		expect([...services.values()]).toEqual([
			{
				id: "srv-web",
				name: web.name,
				url: "https://acme-demo-shop-web.onrender.com",
			},
			{
				id: "srv-api",
				name: api.name,
				url: "https://acme-demo-shop-api.onrender.com",
			},
		]);
		expect(onPoll.mock.calls.map(([detail]) => detail)).toEqual([
			"Found 1/2 services",
			"The service lookup failed (attempt 1 of 5): Listing services failed with 503.",
		]);
		expect(urls[0].searchParams.get("ownerId")).toBe("tea-test");
		expect(urls[0].searchParams.getAll("name")).toEqual([web.name, api.name]);
	});

	// The name filter of the API is not the check.
	it("does not take a service whose name only starts with a wanted name", async () => {
		const urls = serveServices([[{ ...web, name: `${web.name}-2` }], [web]]);

		const services = await waitFor([web.name]);

		expect([...services.keys()]).toEqual([web.name]);
		expect(urls).toHaveLength(2);
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

/**
 * No agent can read logs, so this read is how the deploy manager gets them.
 * It must get the logs of the failed deploy, and no line of an earlier one.
 */
describe("fetchDeployLogs", () => {
	beforeEach(() => {
		vi.stubEnv("RENDER_API_KEY", "rnd_test");
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	/** Serve the deploy, and the logs or an error status. Returns each URL. */
	function serve(logs: object | number): URL[] {
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				const parsed = new URL(String(url));
				urls.push(parsed);
				if (parsed.pathname !== "/v1/logs") {
					return Response.json({
						id: "dep-api2",
						// The commit can be days older than its deploy.
						commit: { id: "c0ffee", createdAt: "2026-09-23T09:00:00Z" },
						createdAt: "2026-09-23T10:00:00Z",
						startedAt: "2026-09-23T10:00:05Z",
						finishedAt: "2026-09-23T10:03:00Z",
					});
				}
				return typeof logs === "number"
					? new Response("", { status: logs })
					: Response.json(logs);
			}),
		);
		return urls;
	}

	it("reads the logs of each type in the time range of the deploy, oldest first", async () => {
		const urls = serve({
			logs: [
				{ message: 'npm error Missing script: "migrate"' },
				{ message: "==> Running pre-deploy command 'npm run migrate'" },
			],
		});

		expect(await fetchDeployLogs("srv-api", "dep-api2", "tea-test")).toBe(
			"==> Running pre-deploy command 'npm run migrate'\n" +
				'npm error Missing script: "migrate"',
		);
		expect(urls[0].pathname).toBe("/v1/services/srv-api/deploys/dep-api2");
		expect(Object.fromEntries(urls[1].searchParams)).toEqual({
			ownerId: "tea-test",
			resource: "srv-api",
			startTime: "2026-09-23T10:00:00Z",
			endTime: "2026-09-23T10:03:00Z",
			direction: "backward",
			limit: "100",
		});
	});

	// The logs are only diagnostic. A read that cannot finish must not end a
	// run that a repair can still fix.
	it("gives no logs, and no error, when a read cannot finish", async () => {
		serve(401);

		expect(await fetchDeployLogs("srv-api", "dep-api2", "tea-test")).toBe("");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('"event":"deploy_logs_unavailable"'),
		);
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

/** The gateway links each run to its task run in the Render Dashboard. */
describe("workflowIdOfTaskRun", () => {
	beforeEach(() => vi.stubEnv("RENDER_API_KEY", "rnd_test"));

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	function renderHas(task: Record<string, unknown>) {
		const fetchMock = vi.fn(async (url: string | URL | Request) =>
			String(url).includes("/task-runs/")
				? Response.json({ id: "trn-1", taskId: "tsk-1" })
				: Response.json(task),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("reads the task of the task run, and gives its workflow", async () => {
		const fetchMock = renderHas({ id: "tsk-1", workflowId: "wfl-1" });

		expect(await workflowIdOfTaskRun("trn-1")).toBe("wfl-1");
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`${REST_API}/task-runs/trn-1`,
			`${REST_API}/tasks/tsk-1`,
		]);
	});

	it("fails when the task names no workflow", async () => {
		renderHas({ id: "tsk-1" });

		await expect(workflowIdOfTaskRun("trn-1")).rejects.toThrow(
			"Task tsk-1 names no workflow",
		);
	});
});

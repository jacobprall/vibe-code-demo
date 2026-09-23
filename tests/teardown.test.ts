/**
 * app/teardown.ts makes the factory's only Render API calls that change a
 * service, a database, or a project. These tests pin down what it deletes and
 * when: only when no sync of an earlier commit can run, and only in the app's
 * own project. A fake fetch holds the workspace, and a fake clock runs the
 * waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSpec } from "../app/contracts.js";
import { deleteAppResources, type TeardownOptions } from "../app/teardown.js";

const spec: AppSpec = {
	user: "demo",
	appName: "shop",
	prompt: "Sell handmade walnut furniture online",
	summary: "A storefront, an API, and Postgres behind it.",
	createdAt: "2026-01-01T00:00:00.000Z",
	resourcePrefix: "vibe",
	tiers: ["static_site", "web_service", "postgres"],
	manifest: {
		services: [
			{
				name: "web",
				kind: "static_site",
				rootDir: "web",
				runtime: "static",
				buildCommand: "npm ci && npm run build",
				staticPublishPath: "dist",
			},
			{
				name: "api",
				kind: "web_service",
				rootDir: "api",
				runtime: "node",
				buildCommand: "npm ci && npm run build",
				startCommand: "npm start",
			},
		],
		databases: [{ name: "db" }],
	},
	notes: [],
	deletedAt: "2026-01-02T00:00:00.000Z",
};

const OPTIONS: TeardownOptions = {
	workspaceId: "tea-test",
	blueprintId: "exs-apps",
	pushedAt: null,
	syncTimeoutMs: 60_000,
};

const SHOP = {
	id: "prj-shop",
	name: "vibe-demo-shop",
	environmentIds: ["evm-shop"],
};
/** What Render lists for the Blueprint after a push that only removed the app. */
const LISTED = [
	{ id: "srv-web", name: "vibe-demo-shop-web", type: "static_site" },
	{ id: "srv-api", name: "vibe-demo-shop-api", type: "web_service" },
	{ id: "dpg-db", name: "vibe-demo-shop-db", type: "postgres" },
	{ id: "srv-cafe", name: "vibe-demo-cafe-web", type: "static_site" },
];

type SyncState = "created" | "pending" | "running" | "success" | "error";

/** One entry of GET /blueprints/{id}/syncs, as Render sends it. */
function sync(commit: string, state: SyncState) {
	return {
		sync: { id: `exe-${commit}`, commit: { id: commit }, state },
		cursor: "c",
	};
}

interface Workspace {
	/**
	 * GET /blueprints/exs-apps/syncs answers these in order, then repeats the
	 * last. A Response is the answer, an Error is thrown as fetch throws a
	 * network error, and a different value is the JSON body.
	 */
	syncs: unknown[];
	projects: (typeof SHOP)[];
	services: Record<string, { id: string; name: string }[]>;
	postgres: Record<string, { id: string; name: string }[]>;
	/** DELETE answers these statuses in order, then 204. */
	deletes: Record<string, number[]>;
}

let workspace: Workspace;
/** Each request as "METHOD /path", in order. */
let requests: string[];
/** The time on the fake clock of each read of the syncs. */
let syncReads: number[];

function serve(): void {
	requests = [];
	syncReads = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname.replace(/^\/v1/, "");
			const method = init?.method ?? "GET";
			requests.push(`${method} ${path}`);

			if (method === "DELETE") {
				const status = workspace.deletes[path]?.shift() ?? 204;
				return new Response(status === 204 ? null : "refused", { status });
			}
			const environment = url.searchParams.get("environmentId") ?? "";
			switch (path) {
				case "/blueprints/exs-apps/syncs": {
					syncReads.push(Date.now());
					const [next, ...rest] = workspace.syncs;
					if (rest.length > 0) workspace.syncs = rest;
					if (next instanceof Error) throw next;
					// A copy, because the last answer can be sent again.
					return next instanceof Response ? next.clone() : Response.json(next);
				}
				case "/blueprints/exs-apps":
					return Response.json({
						id: "exs-apps",
						status: "in_sync",
						autoSync: true,
						resources: LISTED,
					});
				// A prefix match, so that the test proves the exact match.
				case "/projects":
					return Response.json(
						workspace.projects
							.filter((project) =>
								project.name.startsWith(url.searchParams.get("name") ?? ""),
							)
							.map((project) => ({ project, cursor: "c" })),
					);
				case "/services":
					return Response.json(
						(workspace.services[environment] ?? []).map((service) => ({
							service,
							cursor: "c",
						})),
					);
				case "/postgres":
					return Response.json(
						(workspace.postgres[environment] ?? []).map((postgres) => ({
							postgres,
							cursor: "c",
						})),
					);
				default:
					return new Response("not found", { status: 404 });
			}
		}),
	);
}

/** Run the fake clock until the promise settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
	let done = false;
	const tracked = promise.finally(() => {
		done = true;
	});
	// The caller gets the rejection. This handler only stops a warning.
	tracked.catch(() => {});
	while (!done) await vi.advanceTimersByTimeAsync(5_000);
	return tracked;
}

function deletes(): string[] {
	return requests.filter((request) => request.startsWith("DELETE "));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	process.env.RENDER_API_KEY = "rnd_test";
	workspace = {
		syncs: [[sync("54c1088", "success"), sync("8dfd43a", "success")]],
		projects: [SHOP],
		services: {
			"evm-shop": [
				{ id: "srv-web", name: "vibe-demo-shop-web" },
				{ id: "srv-api", name: "vibe-demo-shop-api" },
			],
		},
		postgres: { "evm-shop": [{ id: "dpg-db", name: "vibe-demo-shop-db" }] },
		deletes: {},
	};
	serve();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("deleteAppResources", () => {
	it("deletes the services, then the databases, then the project", async () => {
		await expect(settle(deleteAppResources(spec, OPTIONS))).resolves.toEqual([
			"vibe-demo-shop-web",
			"vibe-demo-shop-api",
			"vibe-demo-shop-db",
		]);
		expect(deletes()).toEqual([
			"DELETE /services/srv-web",
			"DELETE /services/srv-api",
			"DELETE /postgres/dpg-db",
			"DELETE /projects/prj-shop",
		]);
	});

	// On Render, a push that only removed an app started no sync, and 20
	// minutes later the Blueprint still listed the app's resources. The first
	// version of the delete waited for them to leave that list, and timed out.
	it("deletes an app that the Blueprint still lists after the push that removed it", async () => {
		await expect(
			settle(deleteAppResources(spec, OPTIONS)),
		).resolves.toHaveLength(3);
		expect(requests).not.toContain("GET /blueprints/exs-apps");
		expect(deletes()).toHaveLength(4);
	});

	// A sync of an earlier commit still declares the app, and a sync recreates
	// a declared resource that is missing.
	it("deletes nothing while a sync of the Blueprint waits or runs", async () => {
		workspace.syncs = [
			[sync("c1", "pending"), sync("54c1088", "success")],
			[sync("c1", "running"), sync("54c1088", "success")],
			[sync("c1", "success"), sync("54c1088", "success")],
		];

		await settle(deleteAppResources(spec, OPTIONS));

		expect(syncReads).toHaveLength(3);
		expect(requests.indexOf(deletes()[0])).toBeGreaterThan(
			requests.lastIndexOf("GET /blueprints/exs-apps/syncs"),
		);
	});

	// The push event of an earlier push, from another run, can arrive after the
	// delete's push.
	it("reads the syncs a minute after its push, so that a late push event can start one", async () => {
		const pushedAt = Date.now();

		await settle(deleteAppResources(spec, { ...OPTIONS, pushedAt }));

		expect(syncReads[0]).toBeGreaterThanOrEqual(pushedAt + 60_000);
		expect(deletes()).toHaveLength(4);
	});

	it("does not wait for the push event when an earlier attempt pushed", async () => {
		const start = Date.now();

		await settle(deleteAppResources(spec, OPTIONS));

		expect(syncReads[0]).toBe(start);
	});

	it("deletes nothing when a sync does not finish by the deadline", async () => {
		workspace.syncs = [[sync("c1abcdef99", "running")]];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"Blueprint exs-apps has a sync that did not finish in 1 minutes: c1abcde (running).",
		);
		expect(deletes()).toEqual([]);
	});

	// Without the list, a running sync would look like no sync.
	it("deletes nothing when the Blueprint returns no list of syncs", async () => {
		workspace.syncs = [{ message: "unexpected" }];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"Blueprint exs-apps returned no list of syncs.",
		);
		expect(deletes()).toEqual([]);
	});

	// The wait reads the syncs for up to 6 minutes. One failed request once
	// ended the delete as delete_failed, and a new DELETE was necessary.
	it("reads the syncs again after a read fails, and continues the delete", async () => {
		const onProgress = vi.fn();
		workspace.syncs = [
			new Response("upstream error", { status: 503 }),
			new DOMException(
				"The operation was aborted due to timeout",
				"TimeoutError",
			),
			[sync("c1", "running"), sync("54c1088", "success")],
			new TypeError("fetch failed", { cause: new Error("other side closed") }),
			[sync("c1", "success"), sync("54c1088", "success")],
		];

		await expect(
			settle(deleteAppResources(spec, { ...OPTIONS, onProgress })),
		).resolves.toHaveLength(3);
		expect(syncReads).toHaveLength(5);
		expect(onProgress.mock.calls.map(([detail]) => detail)).toEqual([
			"The Blueprint sync lookup failed (attempt 1 of 5): Listing the syncs of Blueprint exs-apps failed with 503.",
			"The Blueprint sync lookup failed (attempt 2 of 5): The operation was aborted due to timeout",
			"Waiting for a sync of Blueprint exs-apps to finish",
			"The Blueprint sync lookup failed (attempt 1 of 5): fetch failed: other side closed",
			"Deleting vibe-demo-shop-web",
			"Deleting vibe-demo-shop-api",
			"Deleting vibe-demo-shop-db",
			"Deleting project vibe-demo-shop",
		]);
	});

	it("deletes nothing when 5 reads of the syncs in sequence fail", async () => {
		workspace.syncs = [
			...Array.from(
				{ length: 4 },
				() => new Response("upstream error", { status: 503 }),
			),
			new TypeError("fetch failed", { cause: new Error("other side closed") }),
		];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"The Blueprint sync lookup failed 5 times in sequence. " +
				"The last error: fetch failed: other side closed",
		);
		expect(syncReads).toHaveLength(5);
		expect(deletes()).toEqual([]);
	});

	// A new attempt cannot repair the API key.
	it.each([401, 403])(
		"fails at once, and deletes nothing, when a read of the syncs gets a %i",
		async (status) => {
			workspace.syncs = [new Response("", { status })];

			await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
				`Listing the syncs of Blueprint exs-apps failed with ${status}.`,
			);
			expect(syncReads).toHaveLength(1);
			expect(deletes()).toEqual([]);
		},
	);

	it("does not wait when no Blueprint watches the apps repository", async () => {
		await settle(deleteAppResources(spec, { ...OPTIONS, blueprintId: null }));

		expect(syncReads).toEqual([]);
		expect(deletes()).toHaveLength(4);
	});

	// The name filter of the API is not the check. App "shop-v2" has a project
	// name that starts with the project name of app "shop".
	it("does not touch a project whose name only starts with the app's name", async () => {
		workspace.projects = [
			{ id: "prj-v2", name: "vibe-demo-shop-v2", environmentIds: ["evm-v2"] },
		];
		workspace.services = {
			"evm-v2": [{ id: "srv-v2", name: "vibe-demo-shop-v2-web" }],
		};

		await expect(settle(deleteAppResources(spec, OPTIONS))).resolves.toEqual(
			[],
		);
		expect(deletes()).toEqual([]);
	});

	it("keeps a resource that the factory did not name, and the project with it", async () => {
		workspace.services["evm-shop"].push({ id: "srv-grafana", name: "grafana" });

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"Project vibe-demo-shop also holds grafana, which the factory did not create.",
		);
		expect(deletes()).toEqual([
			"DELETE /services/srv-web",
			"DELETE /services/srv-api",
			"DELETE /postgres/dpg-db",
		]);
	});

	// A new attempt of a delete finds what an earlier attempt deleted.
	it("counts a resource that is already gone as deleted", async () => {
		workspace.deletes["/services/srv-web"] = [404];

		await expect(settle(deleteAppResources(spec, OPTIONS))).resolves.toContain(
			"vibe-demo-shop-web",
		);
		expect(deletes()).toContain("DELETE /projects/prj-shop");
	});

	it("tries the project again when Render answers that it is not empty", async () => {
		workspace.deletes["/projects/prj-shop"] = [409, 409];

		await settle(deleteAppResources(spec, OPTIONS));

		expect(
			deletes().filter((request) => request === "DELETE /projects/prj-shop"),
		).toHaveLength(3);
	});

	it("stops when Render refuses to delete a resource", async () => {
		workspace.deletes["/services/srv-api"] = [403];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"Render did not delete vibe-demo-shop-api (403)",
		);
		expect(deletes()).not.toContain("DELETE /postgres/dpg-db");
		expect(deletes()).not.toContain("DELETE /projects/prj-shop");
	});

	it("deletes nothing for an app that has no project", async () => {
		workspace.projects = [];

		await expect(settle(deleteAppResources(spec, OPTIONS))).resolves.toEqual(
			[],
		);
		expect(deletes()).toEqual([]);
	});

	// The Workflows logs are the record of what the factory deleted.
	it("logs each resource and the project that it deletes", async () => {
		await settle(deleteAppResources(spec, OPTIONS));

		const events = vi
			.mocked(console.log)
			.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(events).toEqual([
			expect.objectContaining({
				event: "render_resource_deleted",
				id: "srv-web",
			}),
			expect.objectContaining({
				event: "render_resource_deleted",
				id: "srv-api",
			}),
			expect.objectContaining({
				event: "render_resource_deleted",
				id: "dpg-db",
			}),
			expect.objectContaining({
				event: "render_project_deleted",
				id: "prj-shop",
			}),
		]);
	});

	it("sends the API key and only the workspace of the factory", async () => {
		await settle(deleteAppResources(spec, OPTIONS));

		const calls = vi.mocked(fetch).mock.calls;
		for (const [input, init] of calls) {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer rnd_test",
			);
			const url = new URL(String(input));
			if (
				!url.pathname.startsWith("/v1/blueprints/") &&
				init?.method !== "DELETE"
			) {
				expect(url.searchParams.get("ownerId")).toBe("tea-test");
			}
		}
	});
});

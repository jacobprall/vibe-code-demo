/**
 * app/teardown.ts makes the factory's only calls to a Render write API. These
 * tests pin down what it deletes and when: only after the Blueprint stops
 * managing the app, and only in the app's own project. A fake fetch holds the
 * workspace, and a fake clock runs the waits.
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
	releaseTimeoutMs: 60_000,
};

const SHOP = {
	id: "prj-shop",
	name: "vibe-demo-shop",
	environmentIds: ["evm-shop"],
};
const MANAGED = [
	{ id: "srv-web", name: "vibe-demo-shop-web", type: "static_site" },
	{ id: "srv-api", name: "vibe-demo-shop-api", type: "web_service" },
	{ id: "dpg-db", name: "vibe-demo-shop-db", type: "postgres" },
];
const OTHER_APP = {
	id: "srv-cafe",
	name: "vibe-demo-cafe-web",
	type: "static_site",
};

interface Workspace {
	/** GET /blueprints/exs-apps answers these in order, then repeats the last. */
	blueprint: { status: string; autoSync: boolean; resources: typeof MANAGED }[];
	projects: (typeof SHOP)[];
	services: Record<string, { id: string; name: string }[]>;
	postgres: Record<string, { id: string; name: string }[]>;
	/** DELETE answers these statuses in order, then 204. */
	deletes: Record<string, number[]>;
}

let workspace: Workspace;
/** Each request as "METHOD /path", in order. */
let requests: string[];

function serve(): void {
	requests = [];
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
				case "/blueprints/exs-apps": {
					const [next, ...rest] = workspace.blueprint;
					if (rest.length > 0) workspace.blueprint = rest;
					return Response.json({ id: "exs-apps", ...next });
				}
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
	process.env.RENDER_API_KEY = "rnd_test";
	workspace = {
		blueprint: [{ status: "in_sync", autoSync: true, resources: [OTHER_APP] }],
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

	// A resource deleted while the Blueprint manages it comes back on the next
	// sync.
	it("deletes nothing until the Blueprint stops managing the app", async () => {
		workspace.blueprint = [
			{ status: "in_sync", autoSync: true, resources: [...MANAGED, OTHER_APP] },
			{ status: "syncing", autoSync: true, resources: [...MANAGED, OTHER_APP] },
			{ status: "in_sync", autoSync: true, resources: [OTHER_APP] },
		];

		await settle(deleteAppResources(spec, OPTIONS));

		const reads = requests.filter((r) => r === "GET /blueprints/exs-apps");
		expect(reads).toHaveLength(3);
		expect(requests.indexOf(deletes()[0])).toBeGreaterThan(
			requests.lastIndexOf("GET /blueprints/exs-apps"),
		);
	});

	// A sync that started before the app left the file can still create one of
	// its resources.
	it("waits for a sync to finish when the Blueprint no longer lists the app", async () => {
		workspace.blueprint = [
			{ status: "syncing", autoSync: true, resources: [OTHER_APP] },
			{ status: "in_sync", autoSync: true, resources: [OTHER_APP] },
		];

		await settle(deleteAppResources(spec, OPTIONS));

		expect(
			requests.filter((r) => r === "GET /blueprints/exs-apps"),
		).toHaveLength(2);
		expect(deletes()).toHaveLength(4);
	});

	it("deletes nothing when the Blueprint still manages the app at the deadline", async () => {
		workspace.blueprint = [
			{ status: "in_sync", autoSync: false, resources: [...MANAGED] },
		];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"still manages vibe-demo-shop-web, vibe-demo-shop-api, vibe-demo-shop-db after 1 minutes. Auto Sync is off",
		);
		expect(deletes()).toEqual([]);
	});

	// Without the list, a managed resource would look released.
	it("deletes nothing when the Blueprint does not list its resources", async () => {
		workspace.blueprint = [
			{ status: "in_sync", autoSync: true } as Workspace["blueprint"][number],
		];

		await expect(settle(deleteAppResources(spec, OPTIONS))).rejects.toThrow(
			"Blueprint exs-apps returned no resource list.",
		);
		expect(deletes()).toEqual([]);
	});

	it("does not wait when no Blueprint watches the apps repository", async () => {
		await settle(deleteAppResources(spec, { ...OPTIONS, blueprintId: null }));

		expect(requests).not.toContain("GET /blueprints/exs-apps");
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

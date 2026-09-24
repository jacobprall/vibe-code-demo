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
import type { AppFile } from "../app/git.js";
import type { DeployOutcome } from "../app/render.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";
import {
	awaitDeployment,
	checkStaticSiteEnvVars,
	deleteApp,
	deleteResourcesTask,
	promptToApp,
	publishAppTask,
	removeApp,
	removeFilesTask,
	removeFromBlueprintTask,
	verifyAppTask,
	waitForSyncsTask,
} from "../app/workflow.js";

const mocks = vi.hoisted(() => ({
	architectTask: vi.fn(),
	buildTask: vi.fn(),
	deployManagerTask: vi.fn(),
	commitPaths: vi.fn(),
	pushVerified: vi.fn(),
	githubToken: vi.fn(),
	cloneAppsRepo: vi.fn(),
	readAppFiles: vi.fn(),
	writeAppFiles: vi.fn(),
	createSandbox: vi.fn(),
	connectSandbox: vi.fn(),
	findBlueprint: vi.fn(),
	pageContains: vi.fn(),
	waitForServices: vi.fn(),
	waitForDeploy: vi.fn(),
	waitForHttpOk: vi.fn(),
	deleteAppResources: vi.fn(),
	waitForBlueprintSyncs: vi.fn(),
	claimRunApp: vi.fn(async () => true),
	deleteRuns: vi.fn(async () => {}),
	failDelete: vi.fn(async () => {}),
	finishRun: vi.fn(async () => {}),
}));

vi.mock("../app/agents.js", () => ({
	architectTask: { name: "architect", func: mocks.architectTask },
	buildTask: { name: "builder", func: mocks.buildTask },
	deployManagerTask: { name: "deploy-manager", func: mocks.deployManagerTask },
}));

/**
 * Runs each subtask in this process, with the body of its task definition. As
 * on Render, the input and the result go through JSON.
 */
const tasks: TaskContext = {
	run: async (task, ...args) => wire(await task.func(tasks, ...wire(args))),
};

function wire<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Runs each subtask as `tasks` does, and records its name and its input. */
function recordSubtasks(): {
	context: TaskContext;
	runs: { name: string; input: unknown }[];
} {
	const runs: { name: string; input: unknown }[] = [];
	return {
		runs,
		context: {
			run: (task, ...args) => {
				runs.push({ name: task.name, input: args[0] });
				return tasks.run(task, ...args);
			},
		},
	};
}

vi.mock("../app/store.js", () => ({
	claimRunApp: mocks.claimRunApp,
	deleteRuns: mocks.deleteRuns,
	failDelete: mocks.failDelete,
	finishRun: mocks.finishRun,
	setDeleteProgress: vi.fn(async () => {}),
	setRunStage: vi.fn(async () => {}),
	setRunUrls: vi.fn(async () => {}),
	touchRun: vi.fn(async () => {}),
}));

// Commit and push go to GitHub. The copy of the files of an app is a fake
// that moves files between two fake sandboxes: tests/git.test.ts runs the
// real one with git and tar. The verification commands stay real and go to
// the fake sandbox.
vi.mock("../app/git.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/git.js")>()),
	commitPaths: mocks.commitPaths,
	pushVerified: mocks.pushVerified,
	githubToken: mocks.githubToken,
	cloneAppsRepo: mocks.cloneAppsRepo,
	readAppFiles: mocks.readAppFiles,
	writeAppFiles: mocks.writeAppFiles,
}));

vi.mock("../app/sandbox.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/sandbox.js")>()),
	createSandbox: mocks.createSandbox,
	connectSandbox: mocks.connectSandbox,
}));

vi.mock("../app/teardown.js", () => ({
	deleteAppResources: mocks.deleteAppResources,
	waitForBlueprintSyncs: mocks.waitForBlueprintSyncs,
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
	manifest,
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
	mocks.buildTask.mockResolvedValue({
		summary: "Fixed the migration.",
		manifest: repaired,
	});
}

/** The API service in a Blueprint, after a YAML parse. */
function apiBlock(blueprint: string | undefined) {
	const services = parse(blueprint ?? "").projects[0].environments[0].services;
	return services.find(
		(service: { name: string }) => service.name === "acme-demo-shop-api",
	);
}

/** The in-memory file system of each fake sandbox. */
const filesystems = new WeakMap<Sandbox, Map<string, string>>();

/** Specs as `find` in readAllSpecs() lists them: apps/<user>/<app>/factory.json. */
const SPEC_PATH = new RegExp(
	`^${factoryConfig.repoDir}/${factoryConfig.appsDir}/[^/]+/[^/]+/factory\\.json$`,
);

/**
 * A sandbox with an in-memory file system. It answers the commands of
 * verify(), of the root Blueprint regeneration, and of removeApp(). Other
 * commands succeed.
 */
function fakeSandbox(files: Map<string, string>, id = "sbx-clone") {
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
			const specs = [...files.keys()].filter((path) => SPEC_PATH.test(path));
			return { output: specs.join("\n"), exitCode: 0 };
		}
		if (command.startsWith("ls -A ")) {
			return { output: "api\nweb\n", exitCode: 0 };
		}
		return { output: "", exitCode: 0 };
	});

	const sandbox = {
		id,
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
	filesystems.set(sandbox, files);

	return { sandbox, run };
}

function filesystem(sandbox: Sandbox): Map<string, string> {
	const files = filesystems.get(sandbox);
	if (!files) throw new Error(`${sandbox.id} is not a fake sandbox`);
	return files;
}

/** The apps repository, as the sandbox of each push clones it. */
let files: Map<string, string>;
let fake: ReturnType<typeof fakeSandbox>;
/** The sandbox of the run: the agents and verify-app work in it. */
let buildFiles: Map<string, string>;
let build: ReturnType<typeof fakeSandbox>;
/** The checkout at each commit, which is what the push sends to Render. */
let commits: Map<string, string>[];

// verify-app and publish-app connect to the sandbox of their parent by its id.
mocks.connectSandbox.mockImplementation((sandboxId: string) => {
	expect(sandboxId).toBe(build.sandbox.id);
	return build.sandbox;
});

// The files below the app directory of one fake sandbox go into the app
// directory of another.
mocks.readAppFiles.mockImplementation(
	async (sandbox: Sandbox, appDir: string) => ({
		files: [...filesystem(sandbox)]
			.filter(([path]) => path.startsWith(`${appDir}/`))
			.map(([path, contents]) => ({
				path: path.slice(appDir.length + 1),
				data: Buffer.from(contents),
				executable: false,
			})),
	}),
);
mocks.writeAppFiles.mockImplementation(
	async (sandbox: Sandbox, appDir: string, copied: AppFile[]) => {
		const target = filesystem(sandbox);
		for (const path of [...target.keys()]) {
			if (path.startsWith(`${appDir}/`)) target.delete(path);
		}
		for (const { path, data } of copied) {
			target.set(`${appDir}/${path}`, data.toString());
		}
	},
);

/** The sandbox of the run, with the files of the builder. */
function newBuild(entries: [string, string][] = []): void {
	buildFiles = new Map(entries);
	build = fakeSandbox(buildFiles, "sbx-build");
}

function deploy(context = tasks) {
	return awaitDeployment({
		tasks: context,
		sandbox: build.sandbox,
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
		process.env.APPS_REPO = "acme/apps";

		// What run() published before the first deploy.
		files = new Map([[APP_SPEC, `${JSON.stringify(spec, null, 2)}\n`]]);
		fake = fakeSandbox(files);
		// Each publish clones the apps repository in a sandbox of its own.
		mocks.createSandbox.mockResolvedValue(fake.sandbox);
		newBuild([[`${APP_DIR}/web/index.html`, STOREFRONT_HTML]]);
		commits = [];

		mocks.githubToken.mockResolvedValue("token");
		mocks.cloneAppsRepo.mockResolvedValue("https://github.com/acme/apps.git");
		// verify-app and publish-app log a JSON event.
		vi.spyOn(console, "log").mockImplementation(() => {});
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
			async (_workspaceId: string, names: string[]) =>
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
			async (serviceId: string) =>
				serviceId === "srv-acme-demo-shop-api"
					? (apiDeploys.shift() ?? LIVE)
					: LIVE,
		);
		mocks.deployManagerTask.mockResolvedValue({
			allHealthy: false,
			failures: [
				{
					serviceName: "acme-demo-shop-api",
					status: "pre_deploy_failed",
					diagnosis: 'npm error Missing script: "migrate"',
				},
			],
		});
		mocks.waitForHttpOk.mockResolvedValue({
			ok: true,
			status: 200,
			body: '[{"id":1}]',
			headers: new Headers({ "access-control-allow-origin": "*" }),
		});
		mocks.pageContains.mockResolvedValue(true);

		mocks.commitPaths.mockImplementation(async () => {
			commits.push(new Map(files));
			return "b".repeat(40);
		});
		mocks.pushVerified.mockResolvedValue("b".repeat(40));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// On Render, each subtask has its own run, with its own logs.
	it("verifies and publishes the repair in subtasks", async () => {
		builderReturns(repair);
		const { context, runs } = recordSubtasks();

		await deploy(context);

		expect(runs.map(({ name }) => name)).toEqual([
			"deploy-manager",
			"builder",
			"verify-app",
			"publish-app",
		]);
		expect(runs[3].input).toMatchObject({
			sandboxId: build.sandbox.id,
			message: "Fix Render deploy for demo/shop (round 1)",
		});
		expect(logged("log")).toEqual([
			{ event: "app_verified", user: "demo", appName: "shop" },
			{
				event: "app_published",
				user: "demo",
				appName: "shop",
				commit: "b".repeat(40),
			},
		]);
	});

	it("pushes nothing when the repair fails verification", async () => {
		builderReturns({
			...manifest,
			services: manifest.services.map((service) =>
				service.name === "web"
					? {
							...service,
							envVars: [
								{
									key: "VITE_API_HOST",
									fromService: { name: "api", property: "host" },
								},
							],
						}
					: service,
			),
		});

		const result = await deploy();

		expect(result.status).toBe("deploy_failed");
		expect(result.summary).toContain(
			"Deploy repair round 1 failed local verification: web: envVar VITE_API_HOST uses fromService property host.",
		);
		expect(mocks.commitPaths).not.toHaveBeenCalled();
		expect(mocks.pushVerified).not.toHaveBeenCalled();
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
		// The files of the repaired app come from the sandbox of the run.
		expect(commit.get(`${APP_DIR}/web/index.html`)).toBe(STOREFRONT_HTML);
		expect(mocks.readAppFiles).toHaveBeenLastCalledWith(build.sandbox, APP_DIR);
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
	// When another run pushes first, the clone takes the new tip, and the
	// change of the repair runs again on it.
	it("makes the repair again on the new tip", async () => {
		builderReturns(repair);
		await deploy();

		const redo = mocks.pushVerified.mock.calls[0][5];
		// The new tip, as the other run left it: its own app, and a root
		// Blueprint without the repair.
		files.set(CAFE_SPEC, json(cafe));
		files.set(ROOT_BLUEPRINT, rootBlueprint([cafe]));
		await expect(redo()).resolves.toBe("b".repeat(40));

		const services = parse(files.get(ROOT_BLUEPRINT) ?? "").projects.flatMap(
			(project: { environments: { services: { name: string }[] }[] }) =>
				project.environments[0].services,
		);
		expect(
			services.find(
				(service: { name: string }) => service.name === "acme-demo-shop-api",
			),
		).toMatchObject({ preDeployCommand: "npm run db:migrate" });
		expect(services.map((service: { name: string }) => service.name)).toContain(
			"acme-demo-cafe-web",
		);
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
			expect(mocks.commitPaths).not.toHaveBeenCalled();
			expect(mocks.pushVerified).not.toHaveBeenCalled();
			expect(JSON.parse(files.get(APP_SPEC) ?? "").manifest).toEqual(manifest);
		},
	);

	/**
	 * Right after a repair push, the newest deploy of the failed service is
	 * still the failed deploy: Render creates the new deploy only after the
	 * GitHub webhook and the Blueprint sync. The loop once took that failed
	 * deploy as the result of the repair. It then repaired again, and at the
	 * end it reported a status from before the repair.
	 *
	 * These tests use the real waitForDeploy(). A fake Render API gives the
	 * result of each poll of the deploys of a service.
	 */
	describe("after a repair push", () => {
		const WEB_ID = "srv-acme-demo-shop-web";
		const API_ID = "srv-acme-demo-shop-api";
		const LIVE_WEB = { id: "dep-web1", status: "live" };
		const FAILED_API = { id: "dep-api1", status: "pre_deploy_failed" };

		beforeEach(async () => {
			const render =
				await vi.importActual<typeof import("../app/render.js")>(
					"../app/render.js",
				);
			mocks.waitForDeploy.mockImplementation(render.waitForDeploy);
			vi.useFakeTimers();
			vi.stubEnv("RENDER_API_KEY", "rnd_test");
			vi.spyOn(console, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			vi.mocked(console.warn).mockRestore();
		});

		/**
		 * Each poll of the deploys of a service gets the next deploy in its
		 * script, or the next error status. After the last one, each poll gets
		 * the last one again. Returns the number of polls of each service.
		 */
		function fakeRender(
			scripts: Record<string, ({ id: string; status: string } | number)[]>,
		): Map<string, number> {
			const polls = new Map<string, number>();
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string | URL | Request) => {
					const path = new URL(String(url)).pathname;
					const serviceId = path.match(/^\/v1\/services\/([^/]+)\/deploys$/)?.[1];
					const script = serviceId ? scripts[serviceId] : undefined;
					if (!serviceId || !script) {
						throw new Error(`Unexpected request to ${url}`);
					}
					const poll = polls.get(serviceId) ?? 0;
					polls.set(serviceId, poll + 1);
					const result = script[Math.min(poll, script.length - 1)];
					return typeof result === "number"
						? new Response("", { status: result })
						: Response.json([{ deploy: result, cursor: "c" }]);
				}),
			);
			return polls;
		}

		/** Deploy, and run the sleeps between the polls at once. */
		async function deployOn() {
			const [result] = await Promise.all([deploy(), vi.runAllTimersAsync()]);
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
			const polls = fakeRender({
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

			const result = await deployOn();

			expect(result.status, result.summary).toBe("deployed");
			expect(mocks.buildTask).toHaveBeenCalledTimes(1);
			expect(mocks.pushVerified).toHaveBeenCalledTimes(1);
			expect(polls.get(API_ID)).toBe(4);
			// The storefront was live, and the repair did not change it.
			expect(polls.get(WEB_ID)).toBe(1);
		});

		// The run pushed, and Render deploys the push. A poll that fails once
		// must not end the run.
		it("continues to wait when a poll fails after the repair push", async () => {
			builderReturns(repair);
			const polls = fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [
					FAILED_API,
					502,
					{ id: "dep-api2", status: "live" },
				],
			});

			const result = await deployOn();

			expect(result.status, result.summary).toBe("deployed");
			expect(mocks.pushVerified).toHaveBeenCalledTimes(1);
			expect(polls.get(API_ID)).toBe(3);
		});

		it("reports the status of the deploy of the last repair", async () => {
			builderReturns(repair);
			fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [
					FAILED_API,
					FAILED_API,
					{ id: "dep-api2", status: "build_failed" },
					{ id: "dep-api2", status: "build_failed" },
					{ id: "dep-api3", status: "update_failed" },
				],
			});

			const result = await deployOn();

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
			fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [FAILED_API],
			});

			const result = await deployOn();

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
			mocks.commitPaths.mockResolvedValue(null);
			fakeRender({
				[WEB_ID]: [LIVE_WEB],
				[API_ID]: [FAILED_API],
			});

			const result = await deployOn();

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

/**
 * awaiting_blueprint tells the user to create a Blueprint. A lookup error once
 * gave that status, although a Blueprint watched the repository.
 */
describe("awaitDeployment Blueprint lookup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		files = new Map([[APP_SPEC, `${JSON.stringify(spec, null, 2)}\n`]]);
		fake = fakeSandbox(files);
		newBuild();
	});

	it("gives awaiting_blueprint when no Blueprint watches the path", async () => {
		mocks.findBlueprint.mockResolvedValue(null);

		const result = await deploy();

		expect(result.status).toBe("awaiting_blueprint");
		expect(result.summary).toContain(
			"no Blueprint in workspace tea-test is watching render.yaml",
		);
		expect(mocks.waitForServices).not.toHaveBeenCalled();
	});

	it("ends the run with the error when the lookup fails", async () => {
		const error = new Error(
			"The Blueprint lookup failed 5 times in sequence. " +
				"The last error: Listing Blueprints failed with 503.",
		);
		mocks.findBlueprint.mockRejectedValue(error);

		await expect(deploy()).rejects.toBe(error);
		expect(mocks.waitForServices).not.toHaveBeenCalled();
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

/** What the gateway gives delete-app for the shop app. */
const SHOP_APP = { user: "demo", appName: "shop" };

/** The JSON events that the delete writes with one console method, in order. */
function logged(method: "log" | "warn" | "error"): Record<string, unknown>[] {
	return vi
		.mocked(console[method])
		.mock.calls.flatMap(([line]) =>
			typeof line === "string" && line.startsWith("{")
				? [JSON.parse(line)]
				: [],
		);
}

/**
 * A Blueprint sync recreates a declared resource that is missing, and it
 * never deletes a resource. So the order is the contract: the app leaves the
 * Blueprint, the syncs of earlier commits finish, then Render deletes its
 * resources, then its files go.
 */
describe("removeApp", () => {
	/** Each commit, push, wait, and Render delete, in order. */
	let steps: string[];
	/** The files of the last commit. */
	let head: Map<string, string>;

	/** The apps repository as the sandbox of each step clones it. */
	function clone(entries: [string, string][]): void {
		files = new Map(entries);
		fake = fakeSandbox(files);
		head = new Map(files);
		mocks.createSandbox.mockResolvedValue(fake.sandbox);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.APPS_REPO = "acme/apps";
		process.env.RENDER_WORKSPACE_ID = "tea-test";
		steps = [];
		commits = [];
		clone([
			[APP_SPEC, json(spec)],
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
		]);
		mocks.githubToken.mockResolvedValue("token");
		mocks.cloneAppsRepo.mockResolvedValue("https://github.com/acme/apps.git");

		// As git does, make no commit when nothing changed.
		mocks.commitPaths.mockImplementation(async () => {
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
		mocks.waitForBlueprintSyncs.mockImplementation(async () => {
			steps.push("wait for syncs");
		});
		mocks.deleteAppResources.mockImplementation(async () => {
			steps.push("delete resources");
			return SHOP_RESOURCES;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("deletes the resources after the app leaves the Blueprint and the syncs finish, and the files last", async () => {
		await expect(removeApp(tasks, SHOP_APP)).resolves.toEqual(SHOP_RESOURCES);

		expect(steps).toEqual([
			"commit",
			"push",
			"wait for syncs",
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

	// On Render, each step then has its own run, with its own logs.
	it("runs each step as a subtask", async () => {
		const { context, runs } = recordSubtasks();
		await removeApp(context, SHOP_APP);

		expect(runs.map(({ name }) => name)).toEqual([
			"remove-app-from-blueprint",
			"wait-for-blueprint-syncs",
			"delete-app-resources",
			"remove-app-files",
		]);
	});

	it("waits for the syncs of the Blueprint that watches the apps repository", async () => {
		await removeApp(tasks, SHOP_APP);

		expect(mocks.findBlueprint).toHaveBeenCalledWith({
			workspaceId: "tea-test",
			repo: "https://github.com/acme/apps",
			branch: factoryConfig.branch,
			path: factoryConfig.blueprintPath,
		});
		expect(mocks.waitForBlueprintSyncs).toHaveBeenCalledWith(
			"exs-test",
			expect.objectContaining({
				// The wait gives Render time to receive this push.
				pushedAt: expect.any(Number),
			}),
		);
	});

	// The spec stays in the apps repository, so the task input stays small.
	it("gives the teardown only the fields of the spec that name the resources", async () => {
		await removeApp(tasks, SHOP_APP);

		expect(mocks.deleteAppResources).toHaveBeenCalledWith(
			{ user: "demo", appName: "shop", resourcePrefix: "acme" },
			expect.objectContaining({ workspaceId: "tea-test" }),
		);
	});

	// Only a Blueprint creates the resources of an app, so without one no sync
	// can bring a resource back.
	it("deletes without a wait when no Blueprint watches the apps repository", async () => {
		mocks.findBlueprint.mockResolvedValue(null);

		await expect(removeApp(tasks, SHOP_APP)).resolves.toEqual(SHOP_RESOURCES);

		expect(mocks.waitForBlueprintSyncs).not.toHaveBeenCalled();
		expect(steps).toEqual([
			"commit",
			"push",
			"delete resources",
			"commit",
			"push",
		]);
		expect(logged("warn")).toContainEqual(
			expect.objectContaining({ event: "blueprint_not_found" }),
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

		await removeApp(tasks, SHOP_APP);

		expect(steps).toEqual([
			"wait for syncs",
			"delete resources",
			"commit",
			"push",
		]);
		expect(mocks.waitForBlueprintSyncs).toHaveBeenCalledWith(
			"exs-test",
			expect.objectContaining({ pushedAt: null }),
		);
		expect(logged("log")).toContainEqual({
			event: "app_removed_from_blueprint",
			user: "demo",
			appName: "shop",
			deletedAt,
			commit: null,
		});
	});

	it("deletes nothing on Render for an app that has no spec", async () => {
		clone([[CAFE_SPEC, json(cafe)]]);

		await expect(removeApp(tasks, SHOP_APP)).resolves.toEqual([]);

		expect(mocks.findBlueprint).not.toHaveBeenCalled();
		expect(mocks.waitForBlueprintSyncs).not.toHaveBeenCalled();
		expect(mocks.deleteAppResources).not.toHaveBeenCalled();
		expect(steps).toEqual([]);
		expect(logged("log")).toContainEqual({
			event: "app_spec_not_found",
			user: "demo",
			appName: "shop",
		});
	});

	it("keeps the files and the spec when Render does not delete a resource", async () => {
		mocks.deleteAppResources.mockRejectedValue(
			new Error("Render did not delete acme-demo-shop-api (403)"),
		);

		await expect(removeApp(tasks, SHOP_APP)).rejects.toThrow("(403)");

		expect(steps).toEqual(["commit", "push", "wait for syncs"]);
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

		await expect(removeApp(tasks, SHOP_APP)).rejects.toThrow(
			"is not a valid spec of demo/shop",
		);

		expect(steps).toEqual([]);
		expect(files.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
		expect(fake.sandbox.terminate).toHaveBeenCalledTimes(1);
	});

	// A delete of one app changes no file of another app.
	it("commits only the directory of the app and the root Blueprint", async () => {
		await removeApp(tasks, SHOP_APP);

		const scopes = mocks.commitPaths.mock.calls.map(([, , paths]) => paths);
		expect(scopes).toEqual([
			["apps/demo/shop", "render.yaml"],
			["apps/demo/shop", "render.yaml"],
		]);
		for (const call of mocks.pushVerified.mock.calls) {
			expect(call[4]).toEqual(["apps/demo/shop", "render.yaml"]);
		}
	});

	// So that each push starts from the newest commit, and no sandbox runs
	// while the other steps wait.
	it("clones the apps repository in a new sandbox for each push, and terminates it", async () => {
		await removeApp(tasks, SHOP_APP);

		expect(mocks.createSandbox).toHaveBeenCalledTimes(2);
		expect(mocks.cloneAppsRepo).toHaveBeenCalledTimes(2);
		expect(fake.sandbox.terminate).toHaveBeenCalledTimes(2);
	});

	it("logs the commit of each step that pushes", async () => {
		await removeApp(tasks, SHOP_APP);

		expect(logged("log")).toEqual([
			{
				event: "app_removed_from_blueprint",
				user: "demo",
				appName: "shop",
				deletedAt: expect.any(String),
				commit: "c".repeat(40),
			},
			{
				event: "app_files_removed",
				user: "demo",
				appName: "shop",
				commit: "c".repeat(40),
			},
		]);
	});
});

describe("deleteApp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
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
		mocks.commitPaths.mockResolvedValue("c".repeat(40));
		mocks.pushVerified.mockResolvedValue("c".repeat(40));
		mocks.findBlueprint.mockResolvedValue(null);
		mocks.deleteAppResources.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("deletes the runs of the app after the app is gone", async () => {
		await expect(deleteApp.func(tasks, SHOP_APP)).resolves.toMatchObject({
			status: "deleted",
		});

		expect(mocks.deleteRuns).toHaveBeenCalledWith("demo", "shop");
		expect(mocks.failDelete).not.toHaveBeenCalled();
		expect(fake.sandbox.terminate).toHaveBeenCalled();
		expect(logged("log").at(-1)).toEqual({
			event: "app_deleted",
			user: "demo",
			appName: "shop",
			deleted: [],
		});
	});

	it("keeps the runs, marked delete_failed, when the delete fails", async () => {
		mocks.deleteAppResources.mockRejectedValue(
			new Error("Render did not delete acme-demo-shop-db (403)"),
		);

		await expect(deleteApp.func(tasks, SHOP_APP)).rejects.toThrow("(403)");

		expect(mocks.failDelete).toHaveBeenCalledWith(
			"demo",
			"shop",
			"Render did not delete acme-demo-shop-db (403)",
		);
		expect(mocks.deleteRuns).not.toHaveBeenCalled();
		expect(fake.sandbox.terminate).toHaveBeenCalled();
		expect(logged("error")).toEqual([
			{
				event: "app_delete_failed",
				user: "demo",
				appName: "shop",
				error: "Render did not delete acme-demo-shop-db (403)",
			},
		]);
	});

	it("starts no sandbox for an app name that is not a slug", async () => {
		await expect(
			deleteApp.func(tasks, { user: "demo", appName: "../shop" }),
		).rejects.toThrow();
		expect(mocks.createSandbox).not.toHaveBeenCalled();
	});

	// A failed step fails the delete, and the next DELETE starts again at the
	// first step, which reads what the failed attempt left.
	it("registers the delete and each of its steps with no retries", () => {
		for (const definition of [
			deleteApp,
			removeFromBlueprintTask,
			waitForSyncsTask,
			deleteResourcesTask,
			removeFilesTask,
		]) {
			expect(
				TaskRegistry.getInstance().get(definition.name)?.options?.retry,
				definition.name,
			).toEqual({ max_retries: 0, wait_duration_ms: 0 });
		}
	});
});

describe("promptToApp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APPS_REPO = "acme/apps";
		process.env.RENDER_WORKSPACE_ID = "tea-test";
		process.env.RENDER_API_KEY = "rnd_test";
		mocks.architectTask.mockResolvedValue({
			appName: "shop",
			summary: "A storefront for handmade walnut furniture.",
			tiers: [{ kind: "static_site", reason: "The catalog does not change." }],
			assetQueries: [],
			brief: {
				pages: ["Home"],
				features: [],
				voice: "Warm and plain",
				content: "Walnut chairs, oak tables, and ash stools.",
			},
		});
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

	/**
	 * The verification and the publish are subtasks. On Render, each one has
	 * its own run, with its input, its result, and its logs.
	 */
	describe("verify and publish", () => {
		const INPUT = {
			prompt: "Sell handmade walnut furniture online",
			user: "demo",
			runId: "run-1",
		};
		const site: Manifest = {
			services: [
				{
					name: "web",
					kind: "static_site",
					rootDir: "web",
					runtime: "static",
					buildCommand: "npm ci && npm run build",
					staticPublishPath: "dist",
				},
			],
		};

		/** The app of a different user, in the apps repository. */
		const victim: AppSpec = {
			...spec,
			user: "victim",
			appName: "site",
			prompt: "A bakery",
		};
		const VICTIM_DIR = appPath("victim", "site");
		const PUBLISHED_PATHS = ["apps/demo/shop", factoryConfig.blueprintPath];

		function builderOutput(built: Manifest) {
			return { summary: "A storefront.", manifest: built };
		}

		beforeEach(() => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			files = new Map([
				[`${VICTIM_DIR}/factory.json`, json(victim)],
				[`${VICTIM_DIR}/index.html`, STOREFRONT_HTML],
			]);
			fake = fakeSandbox(files);
			newBuild([[`${APP_DIR}/web/index.html`, STOREFRONT_HTML]]);
			// The sandbox of the run first, and then the sandbox of the push.
			mocks.createSandbox
				.mockReset()
				.mockResolvedValueOnce(build.sandbox)
				.mockResolvedValue(fake.sandbox);
			mocks.githubToken.mockResolvedValue("token");
			mocks.cloneAppsRepo.mockResolvedValue("https://github.com/acme/apps.git");
			mocks.buildTask.mockResolvedValue(builderOutput(site));
			mocks.commitPaths.mockResolvedValue("c".repeat(40));
			mocks.pushVerified.mockResolvedValue("c".repeat(40));
			// No Blueprint watches the apps repository, so the run ends after
			// the push.
			mocks.findBlueprint.mockResolvedValue(null);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("verifies the app and then publishes it", async () => {
			const { context, runs } = recordSubtasks();

			const result = await promptToApp.func(context, INPUT);

			expect(result.status, result.summary).toBe("awaiting_blueprint");
			expect(runs.map(({ name }) => name)).toEqual([
				"architect",
				"builder",
				"verify-app",
				"publish-app",
			]);
			expect(runs[2].input).toEqual({
				sandboxId: build.sandbox.id,
				user: "demo",
				appName: "shop",
				manifest: site,
				databaseUrl: null,
			});
			expect(runs[3].input).toEqual({
				sandboxId: build.sandbox.id,
				spec: expect.objectContaining({
					user: "demo",
					appName: "shop",
					manifest: site,
				}),
				message: "demo/shop: Sell handmade walnut furniture online",
			});
			// The clone of the push holds the files of the build.
			expect(files.get(`${APP_DIR}/web/index.html`)).toBe(STOREFRONT_HTML);
			expect(files.get(`${APP_DIR}/.gitignore`)).toContain("node_modules/");
			expect(JSON.parse(files.get(APP_SPEC) ?? "").manifest).toEqual(site);
			expect(files.get(ROOT_BLUEPRINT)).toContain(
				`${factoryConfig.resourcePrefix}-demo-shop-web`,
			);
			expect(build.sandbox.terminate).toHaveBeenCalledTimes(1);
			expect(fake.sandbox.terminate).toHaveBeenCalledTimes(1);
			expect(logged("log")).toEqual([
				{ event: "app_verified", user: "demo", appName: "shop" },
				{
					event: "app_published",
					user: "demo",
					appName: "shop",
					commit: "c".repeat(40),
				},
			]);
		});

		it("gives the failures of verify-app to the builder, and publishes only after a pass", async () => {
			mocks.buildTask.mockResolvedValueOnce(
				builderOutput({
					services: [
						{
							...site.services[0],
							envVars: [
								{
									key: "VITE_API_HOST",
									fromService: { name: "api", property: "host" },
								},
							],
						},
					],
				}),
			);
			const { context, runs } = recordSubtasks();

			const result = await promptToApp.func(context, INPUT);

			expect(result.status, result.summary).toBe("awaiting_blueprint");
			expect(runs.map(({ name }) => name)).toEqual([
				"architect",
				"builder",
				"verify-app",
				"builder",
				"verify-app",
				"publish-app",
			]);
			const failure =
				"web: envVar VITE_API_HOST uses fromService property host.";
			expect(mocks.buildTask.mock.calls[1][1].message).toContain(failure);
			expect(logged("log")[0]).toEqual({
				event: "app_verification_failed",
				user: "demo",
				appName: "shop",
				failures: [expect.stringContaining(failure)],
			});
			expect(mocks.commitPaths).toHaveBeenCalledTimes(1);
		});

		/**
		 * The builder can run any command in the sandbox of the run, and a
		 * process that it starts stays there. The token once went into that
		 * sandbox for the clone, and again for the push.
		 */
		it("gives the GitHub token only to the sandbox of the push", async () => {
			mocks.githubToken.mockResolvedValue("ghs_push");
			const { context, runs } = recordSubtasks();

			await promptToApp.func(context, INPUT);

			// After the builder: an installation token expires after an hour,
			// and a run can take two.
			expect(mocks.githubToken).toHaveBeenCalledOnce();
			expect(mocks.githubToken.mock.invocationCallOrder[0]).toBeGreaterThan(
				Math.max(...mocks.buildTask.mock.invocationCallOrder),
			);
			expect(mocks.cloneAppsRepo.mock.calls).toEqual([
				[
					fake.sandbox,
					"ghs_push",
					expect.objectContaining({ fullName: "acme/apps" }),
					factoryConfig.branch,
				],
			]);
			expect(mocks.pushVerified).toHaveBeenCalledWith(
				fake.sandbox,
				"ghs_push",
				"https://github.com/acme/apps.git",
				factoryConfig.branch,
				PUBLISHED_PATHS,
				expect.any(Function),
			);
			// The sandbox of the run gets a repository with no remote.
			const commands = build.run.mock.calls.map(([command]) => command);
			expect(commands[0]).toBe(
				`git init -q '${factoryConfig.repoDir}' && mkdir -p '${APP_DIR}'`,
			);
			expect(commands.join("\n")).not.toMatch(/ghs_|clone|askpass/);
			// The Render Dashboard shows the input of each subtask.
			expect(JSON.stringify(runs)).not.toContain("ghs_");
		});

		it("copies only the app directory out of the sandbox of the run", async () => {
			// The builder can write outside its app directory in its sandbox.
			buildFiles.set(`${VICTIM_DIR}/index.html`, "defaced");

			await promptToApp.func(tasks, INPUT);

			expect(mocks.readAppFiles).toHaveBeenLastCalledWith(
				build.sandbox,
				APP_DIR,
			);
			expect(mocks.writeAppFiles).toHaveBeenCalledWith(
				fake.sandbox,
				APP_DIR,
				expect.any(Array),
			);
			expect(mocks.commitPaths).toHaveBeenCalledWith(
				fake.sandbox,
				"demo/shop: Sell handmade walnut furniture online",
				PUBLISHED_PATHS,
			);
			expect(files.get(`${VICTIM_DIR}/index.html`)).toBe(STOREFRONT_HTML);
			expect(JSON.parse(files.get(`${VICTIM_DIR}/factory.json`) ?? "")).toEqual(
				victim,
			);
		});

		// publish-app writes the spec of the run over a factory.json of the
		// builder, so a build cannot add resources that no run verified.
		it("replaces a factory.json that the builder wrote", async () => {
			buildFiles.set(
				APP_SPEC,
				json({ ...victim, user: "demo", appName: "evil" }),
			);

			await promptToApp.func(tasks, INPUT);

			expect(JSON.parse(files.get(APP_SPEC) ?? "")).toMatchObject({
				user: "demo",
				appName: "shop",
			});
			expect(files.get(ROOT_BLUEPRINT)).not.toContain("demo-evil");
		});

		// The root Blueprint takes each spec of the repository, but only in the
		// directory of the app that it names.
		it("leaves a spec that names a different app out of the root Blueprint", async () => {
			const decoy = `${appPath("demo", "decoy")}/factory.json`;
			files.set(decoy, json({ ...victim, user: "demo", appName: "evil" }));

			await promptToApp.func(tasks, INPUT);

			const root = files.get(ROOT_BLUEPRINT) ?? "";
			expect(root).toContain("acme-victim-site-web");
			expect(root).toContain(`${factoryConfig.resourcePrefix}-demo-shop-web`);
			expect(root).not.toContain("demo-evil");
			expect(logged("warn")).toContainEqual({
				event: "skipped_app_spec",
				path: decoy,
				reason: "it names demo/evil",
			});
		});

		it("gives the builder what publish-app would refuse", async () => {
			const refusal =
				"web/home.html is a symbolic link. Only regular files are published.";
			mocks.readAppFiles.mockResolvedValueOnce({ error: refusal });
			const { context, runs } = recordSubtasks();

			const result = await promptToApp.func(context, INPUT);

			expect(result.status, result.summary).toBe("awaiting_blueprint");
			expect(runs.map(({ name }) => name)).toEqual([
				"architect",
				"builder",
				"verify-app",
				"builder",
				"verify-app",
				"publish-app",
			]);
			expect(mocks.buildTask.mock.calls[1][1].message).toContain(refusal);
		});

		it("pushes nothing when the files of the app change after verify-app", async () => {
			mocks.readAppFiles
				.mockResolvedValueOnce({ files: [] })
				.mockResolvedValueOnce({ error: "web/home.html is a symbolic link." });

			await expect(promptToApp.func(tasks, INPUT)).rejects.toThrow(
				"publish-app did not copy the app. web/home.html is a symbolic link.",
			);

			// No sandbox for the push.
			expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
			expect(mocks.githubToken).not.toHaveBeenCalled();
			expect(mocks.pushVerified).not.toHaveBeenCalled();
		});

		it("ends the run as build_failed when the publish changes no files", async () => {
			mocks.commitPaths.mockResolvedValue(null);

			const result = await promptToApp.func(tasks, INPUT);

			expect(result).toEqual({
				status: "build_failed",
				summary: "The run produced no files.",
			});
			expect(mocks.pushVerified).not.toHaveBeenCalled();
			expect(mocks.findBlueprint).not.toHaveBeenCalled();
		});

		// A retry of publish-app after its push finds nothing to commit. A
		// retry of verify-app after a timeout runs every build again.
		it("registers verify-app and publish-app with no retries", () => {
			for (const definition of [verifyAppTask, publishAppTask]) {
				expect(
					TaskRegistry.getInstance().get(definition.name)?.options?.retry,
					definition.name,
				).toEqual({ max_retries: 0, wait_duration_ms: 0 });
			}
		});
	});
});

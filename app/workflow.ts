/**
 * prompt-to-app — one API call to a deployed app on Render.
 * delete-app — one API call to remove that app again.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import {
	factoryConfig,
	appPath,
	appRelativePath,
} from "../factory.config.js";
import {
	architectTask,
	buildTask,
	curatorTask,
	deployManagerTask,
} from "./agents.js";
import {
	appBlueprint,
	declaredResources,
	resourceNames,
	rootBlueprint,
} from "./blueprint.js";
import { agentJson } from "./claude.js";
import { appsRepo, renderWorkspaceId } from "./config.js";
import {
	type AppSpec,
	type BuildOutput,
	type Manifest,
	appSpecSchema,
	type AssetManifest,
	assetManifestSchema,
	buildOutputSchema,
	type DeleteAppInput,
	type DeleteResourcesInput,
	deleteAppInputSchema,
	deleteResourcesInputSchema,
	type DeployPlan,
	deployDiagnosisSchema,
	deployPlanSchema,
	type PublishAppInput,
	publishAppInputSchema,
	type Service,
	type VerifyAppInput,
	verifyAppInputSchema,
	type WaitForSyncsInput,
	type WorkflowResult,
	waitForSyncsInputSchema,
	workflowInputSchema,
} from "./contracts.js";
import {
	appGitignore,
	cloneAppsRepo,
	commitPaths,
	githubToken,
	initAppDir,
	pushVerified,
	readAppFiles,
	removeIgnored,
	runVerification,
	writeAppFiles,
} from "./git.js";
import { checkManifestCommands } from "./policy.js";
import {
	type DeployOutcome,
	findBlueprint,
	pageContains,
	RenderMcp,
	type ServiceRecord,
	waitForDeploy,
	waitForHttpOk,
	waitForServices,
} from "./render.js";
import {
	connectSandbox,
	createSandbox,
	ensureSandboxPostgres,
	type Sandbox,
	shellEscape,
} from "./sandbox.js";
import {
	claimRunApp,
	deleteRuns,
	failDelete,
	finishRun,
	setDeleteProgress,
	setRunStage,
	setRunUrls,
	touchRun,
} from "./store.js";
import { deleteAppResources, waitForBlueprintSyncs } from "./teardown.js";
import { materializeTemplate } from "./templates.js";

const SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;
const MAX_BUILD_ROUNDS = 2;
const MAX_DEPLOY_REPAIR_ROUNDS = 2;
const SERVICE_TIMEOUT_MS = 6 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const SITE_TIMEOUT_MS = 3 * 60 * 1000;
/** verify-app builds each service and boots each web service. */
const VERIFY_TIMEOUT_SECONDS = 30 * 60;
/** publish-app makes one commit and one push. */
const PUBLISH_TIMEOUT_SECONDS = 10 * 60;
/**
 * A step of a delete makes one push, waits for the syncs of the Blueprint, or
 * makes the deletes on Render.
 */
const DELETE_STEP_TIMEOUT_SECONDS = 10 * 60;
/** delete-app waits for its four steps. */
const DELETE_TIMEOUT_SECONDS = 4 * DELETE_STEP_TIMEOUT_SECONDS;
/** How long an unfinished sync of the apps Blueprint gets before a delete. */
const SYNC_TIMEOUT_MS = 6 * 60 * 1000;
const SMOKE_PORT = 8099;
const BOOT_ATTEMPTS = 15;
/** Directory under templates/ that a multi-service app starts from. */
const FULLSTACK_TEMPLATE = "fullstack";
/** Proves a health endpoint answers before Postgres is reachable, as Render requires. */
const UNREACHABLE_DATABASE_URL = "postgres://unreachable/db";
/** `fromService` properties that give an address on Render's private network. */
const PRIVATE_NETWORK_PROPERTIES = new Set(["host", "port", "hostport"]);

export const promptToApp = task(
	{
		name: "prompt-to-app",
		plan: "standard",
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
		// Render Workflows retries a failed run three times by default. A retry
		// starts again at the architect with a new sandbox, and after a push it
		// can deploy a second app. It also starts after the catch below sets the
		// runs row to "failed", so the concurrency limit does not count it. A
		// caller posts the prompt again to start a new run.
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function promptToApp(
		tasks: TaskContext,
		rawInput: unknown,
	): Promise<WorkflowResult> {
		const { prompt, user, runId } = workflowInputSchema.parse(rawInput);

		try {
			const result = await run(tasks, prompt, user, runId);
			await finishRun(runId, result.status, {
				summary: result.summary.slice(0, 4_000),
			});
			return result;
		} catch (error) {
			const summary = error instanceof Error ? error.message : String(error);
			await finishRun(runId, "failed", {
				summary: summary.slice(0, 1_000),
			}).catch((storeError) =>
				console.error("Failed to record run failure:", storeError),
			);
			throw error;
		}
	},
);

/**
 * The pipeline. Each agent runs as a subtask on its own compute, through
 * `tasks`, the context that Render Workflows gives to prompt-to-app. So do
 * the verification of the app and its publish. On Render, each subtask has
 * its own run, with its input, its result, and its logs.
 *
 * The agents and verify-app work in the sandbox of the run. publish-app
 * copies the files of the app out of it.
 */
async function run(
	tasks: TaskContext,
	prompt: string,
	user: string,
	runId: string,
): Promise<WorkflowResult> {
	const repo = appsRepo();
	const workspaceId = renderWorkspaceId();
	const mcp = RenderMcp.fromEnv();

	// ── Design ──────────────────────────────────────────────────────────
	await setRunStage(runId, "designing");
	const plan = await agentJson(
		(message) => tasks.run(architectTask, { message }),
		deployPlanSchema,
		`Product prompt:\n${prompt}`,
		"architect",
	);

	const appName = plan.appName;
	const blueprintPath = `${appRelativePath(user, appName)}/render.yaml`;
	// Returned, not thrown: a delete in progress is an expected result, not a
	// fault in the run.
	if (!(await claimRunApp(runId, user, { appName, blueprintPath }))) {
		return {
			status: "failed",
			summary: `${user}/${appName} is being deleted. Submit the prompt again when the delete finishes.`,
		};
	}

	const sandbox = await createSandbox({
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	});
	try {
		const appDir = appPath(user, appName);
		// Every agent path resolves against this, so it has to exist first.
		// The agents can run any command in this sandbox, so it gets no clone
		// of the apps repository and no GitHub token: it holds only this app.
		// publish-app pushes from a sandbox of its own.
		await initAppDir(sandbox, appDir);

		// ── Database and skeleton ───────────────────────────────────────
		// A real Postgres, before the builder starts, so the schema and the
		// seed are exercised here rather than for the first time in production.
		let databaseUrl: string | null = null;
		let template: string[] = [];
		if (plan.tiers.some((tier) => tier.kind === "postgres")) {
			await setRunStage(runId, "provisioning");
			databaseUrl = await ensureSandboxPostgres(sandbox);
		}
		// A multi-service app has to get CORS, the API's base URL, and the
		// migration path right before it works at all, and none of those are
		// things the prompt can reliably re-derive per run. The template
		// answers them; the builder still owns the product.
		if (plan.tiers.some((tier) => tier.kind === "web_service")) {
			template = await materializeTemplate(sandbox, FULLSTACK_TEMPLATE, appDir);
		}

		// ── Imagery ─────────────────────────────────────────────────────
		await setRunStage(runId, "curating");
		const assetManifest = await curate(tasks, sandbox, appDir, plan);

		// ── Build and verify ────────────────────────────────────────────
		await setRunStage(runId, "building");
		const built = await buildAndVerify({
			tasks,
			sandbox,
			appDir,
			user,
			plan,
			prompt,
			runId,
			assets: assetManifest,
			databaseUrl,
			template,
		});
		if (!built.passed) {
			return { status: "build_failed", summary: built.failures.slice(0, 2_000) };
		}

		const spec: AppSpec = {
			user,
			appName,
			prompt,
			summary: plan.summary,
			createdAt: new Date().toISOString(),
			resourcePrefix: factoryConfig.resourcePrefix,
			manifest: built.manifest,
		};

		// ── Publish ─────────────────────────────────────────────────────
		await setRunStage(runId, "publishing");
		const { commit } = await tasks.run(publishAppTask, {
			sandboxId: sandbox.id,
			spec,
			message: `${user}/${appName}: ${oneLine(prompt)}`,
		});
		if (!commit) {
			return { status: "build_failed", summary: "The run produced no files." };
		}

		// ── Deploy ──────────────────────────────────────────────────────
		await setRunStage(runId, "deploying");
		return await awaitDeployment({
			tasks,
			mcp,
			sandbox,
			workspaceId,
			repoUrl: repo.url,
			spec,
			appDir,
			runId,
			summary: built.summary,
			databaseUrl,
		});
	} finally {
		await sandbox
			.terminate()
			.catch((error) => console.error("Failed to terminate sandbox:", error));
	}
}

/* ── Imagery ──────────────────────────────────────────────────────────── */

/**
 * Photographs are decoration: the builder falls back to inline SVG and CSS
 * without them. So a curator that runs out of turns, or a Commons outage,
 * degrades the storefront rather than failing a deploy.
 */
async function curate(
	tasks: TaskContext,
	sandbox: Sandbox,
	appDir: string,
	plan: DeployPlan,
): Promise<AssetManifest> {
	if (plan.assetQueries.length === 0) return { assets: [] };

	try {
		return await agentJson(
			(message) =>
				tasks.run(curatorTask, {
					message,
					sandboxId: sandbox.id,
					workDir: appDir,
				}),
			assetManifestSchema,
			curatorMessage(plan, appDir),
			"curator",
		);
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: "curator_skipped",
				reason: error instanceof Error ? error.message : String(error),
			}),
		);
		return { assets: [] };
	}
}

/* ── Build ────────────────────────────────────────────────────────────── */

interface BuildOutcome {
	passed: boolean;
	summary: string;
	manifest: Manifest;
	failures: string;
}

async function buildAndVerify(opts: {
	tasks: TaskContext;
	sandbox: Sandbox;
	appDir: string;
	user: string;
	plan: DeployPlan;
	prompt: string;
	runId: string;
	assets: AssetManifest;
	databaseUrl: string | null;
	template: readonly string[];
}): Promise<BuildOutcome> {
	let buildOutput = await runBuilder(
		opts.tasks,
		opts.sandbox,
		opts.appDir,
		builderMessage(opts),
		"builder",
	);

	for (let round = 0; round <= MAX_BUILD_ROUNDS; round++) {
		// Validate manifest commands through policy before running them.
		const policyViolation = checkManifestCommands(buildOutput.manifest);
		if (policyViolation) {
			return {
				passed: false,
				summary: buildOutput.summary,
				manifest: buildOutput.manifest,
				failures: policyViolation,
			};
		}

		await setRunStage(opts.runId, "verifying");
		const { failures } = await opts.tasks.run(verifyAppTask, {
			sandboxId: opts.sandbox.id,
			user: opts.user,
			appName: opts.plan.appName,
			manifest: buildOutput.manifest,
			databaseUrl: opts.databaseUrl,
		});
		if (failures.length === 0) {
			return {
				passed: true,
				summary: buildOutput.summary,
				manifest: buildOutput.manifest,
				failures: "",
			};
		}
		if (round === MAX_BUILD_ROUNDS) {
			return {
				passed: false,
				summary: buildOutput.summary,
				manifest: buildOutput.manifest,
				failures: failures.join("\n\n"),
			};
		}

		await setRunStage(opts.runId, "building");
		buildOutput = await runBuilder(
			opts.tasks,
			opts.sandbox,
			opts.appDir,
			`Verification failed. Fix exactly what this output names:\n\n${failures.join("\n\n")}`,
			`builder-fix-${round + 1}`,
		);
	}

	return {
		passed: false,
		summary: buildOutput.summary,
		manifest: buildOutput.manifest,
		failures: "Verification never completed.",
	};
}

/**
 * Join a manifest-declared subdirectory onto a base path. The manifest is
 * agent-authored, so tolerate the two things models get wrong: "." or "./"
 * meaning "this directory", and repeating the base path they were given.
 */
function resolveServiceDir(base: string, relative: string): string {
	const cleaned = relative.replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (!cleaned || cleaned === ".") return base;
	if (base.endsWith(`/${cleaned}`)) return base;
	return `${base}/${cleaned}`;
}

/**
 * Verify the builder's files in the sandbox. A check that fails is a result,
 * not an error: the parent gives the failures to the builder, or it ends the
 * run.
 *
 * Render does not retry it. A retry after a timeout runs every build again.
 * And a service that the failed attempt started can still answer on the port
 * of the next boot, so a retry can pass a check that failed.
 */
export const verifyAppTask = task(
	{
		name: "verify-app",
		// The builds run in the sandbox, not on the compute of this task.
		plan: "starter",
		timeoutSeconds: VERIFY_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function verifyApp(
		_tasks: TaskContext,
		input: VerifyAppInput,
	): Promise<{ failures: string[] }> {
		const { sandboxId, user, appName, manifest, databaseUrl } =
			verifyAppInputSchema.parse(input);
		const failures = await verify(
			connectSandbox(sandboxId),
			appPath(user, appName),
			manifest,
			databaseUrl,
		);
		console.log(
			JSON.stringify(
				failures.length === 0
					? { event: "app_verified", user, appName }
					: {
							event: "app_verification_failed",
							user,
							appName,
							// The first line of each. The result has all of the text.
							failures: failures.map((failure) => failure.split("\n", 1)[0]),
						},
			),
		);
		return { failures };
	},
);

/**
 * Generic verification driven by the manifest. It starts from the files a
 * commit holds, because a fresh clone is all that Render's build gets. For
 * each service:
 * - For static sites: reject fromService properties on the private network
 * - Run the buildCommand in its rootDir
 * - For static sites: check staticPublishPath produced an index.html
 * - For web services with a healthCheckPath: boot it and curl the endpoint
 * - For web services with a dataCheckPath: migrate, boot against the sandbox's
 *   Postgres, and require the endpoint to answer with data
 * - Check for placeholder content in built output
 *
 * Last, it reads the files as publish-app does, so that the builder can fix
 * what publish-app would refuse: a symbolic link, for example.
 */
async function verify(
	sandbox: Sandbox,
	appDir: string,
	manifest: Manifest,
	databaseUrl: string | null,
): Promise<string[]> {
	const failures: string[] = [];

	// Only what is inside the app directory can be committed, so an empty one
	// is a build failure however good the model's summary sounds.
	const contents = await sandbox.run(`ls -A ${shellEscape(appDir)}`);
	if (contents.exitCode !== 0 || contents.output.trim() === "") {
		return [
			`Nothing was written to the app directory ${appDir}. ` +
				"Build the application there — relative paths already resolve to it — " +
				"and do not write anywhere else.",
		];
	}

	// Render's build gets only what the commit holds. Delete every ignored file
	// first, so that a file the build needs but a commit leaves out fails here
	// and not in a deploy.
	await sandbox.writeFile(`${appDir}/.gitignore`, appGitignore(manifest));
	await removeIgnored(sandbox, appDir);

	for (const service of manifest.services) {
		// This check needs no build, so a failed build cannot hide it.
		failures.push(...checkStaticSiteEnvVars(service));

		const serviceDir = resolveServiceDir(appDir, service.rootDir);

		// Run the build command.
		const build = await runVerification(sandbox, serviceDir, [
			service.buildCommand,
		]);
		if (!build.passed) {
			failures.push(
				`${service.name} (${service.rootDir}) build failed:\n${build.failures}`,
			);
			continue;
		}

		if (service.kind === "static_site" && service.staticPublishPath) {
			const publishDir = resolveServiceDir(
				serviceDir,
				service.staticPublishPath,
			);
			const index = await sandbox.run(
				`cat ${shellEscape(`${publishDir}/index.html`)}`,
			);
			if (index.exitCode !== 0) {
				failures.push(
					`${service.name}: ${service.staticPublishPath}/index.html was not produced by the build.`,
				);
			} else if (index.output.length < 200) {
				failures.push(
					`${service.name}: index.html is only ${index.output.length} bytes — the build produced an empty page.`,
				);
			} else {
				// Check for placeholder content in the built output.
				const placeholders = await checkForPlaceholders(sandbox, publishDir);
				failures.push(...placeholders);
			}
		}

		if (service.kind === "web_service") {
			failures.push(
				...(await checkWebService(sandbox, serviceDir, service, databaseUrl)),
			);
		}
	}

	const publishable = await readAppFiles(sandbox, appDir);
	if ("error" in publishable) failures.push(publishable.error);

	return failures;
}

/**
 * A static site gets its env vars at build time, and a browser uses them. The
 * sandbox build passes with a private-network address in the bundle. Without
 * this check, only smokeStorefront() finds the fault, after the Blueprint has
 * created every resource. The builder must make the fix, because the
 * storefront code must agree with the value. Web services can use these
 * properties, because they connect on the private network.
 */
export function checkStaticSiteEnvVars(service: Service): string[] {
	if (service.kind !== "static_site") return [];

	const failures: string[] = [];
	for (const { key, fromService } of service.envVars ?? []) {
		if (
			!fromService?.property ||
			!PRIVATE_NETWORK_PROPERTIES.has(fromService.property)
		) {
			continue;
		}
		const { name, property } = fromService;
		failures.push(
			`${service.name}: envVar ${key} uses fromService property ${property}. ` +
				"That is an address on Render's private network, and a static site is not on that network. " +
				"A browser cannot connect to a private-network name. " +
				`Replace property ${property} with envVarKey RENDER_EXTERNAL_HOSTNAME, the public hostname of ${name}.`,
		);
	}
	return failures;
}

/**
 * Two boots, because they prove different things. Against an unreachable
 * database, `healthCheckPath` must still answer — that is what Render's health
 * check does before the database is up, and a health endpoint that queries
 * will fail the deploy. Against the real one, `dataCheckPath` must return
 * data, which is the only check that the schema applied and the seed loaded.
 */
async function checkWebService(
	sandbox: Sandbox,
	serviceDir: string,
	service: Service,
	databaseUrl: string | null,
): Promise<string[]> {
	const failures: string[] = [];
	const startCommand = service.startCommand ?? "npm start";

	if (service.healthCheckPath) {
		const booted = await startService(sandbox, serviceDir, startCommand, {
			databaseUrl: UNREACHABLE_DATABASE_URL,
			readyPath: service.healthCheckPath,
		});
		await stopService(sandbox);
		if (booted) {
			failures.push(
				`${service.name}: GET ${service.healthCheckPath} did not answer within ${BOOT_ATTEMPTS}s with an unreachable database. ` +
					`Render calls it before Postgres is ready, so it must not query. ${booted}`,
			);
		}
	}

	if (!databaseUrl || !service.dataCheckPath) return failures;

	// Exactly what Render will run, in the same order, before the same start
	// command — so a migration that only works by accident fails here instead.
	if (service.preDeployCommand) {
		const migrated = await runVerification(sandbox, serviceDir, [
			`DATABASE_URL=${shellEscape(databaseUrl)} ${service.preDeployCommand}`,
		]);
		if (!migrated.passed) {
			failures.push(
				`${service.name}: preDeployCommand failed against a real Postgres:\n${migrated.failures}`,
			);
			return failures;
		}
	}

	const booted = await startService(sandbox, serviceDir, startCommand, {
		databaseUrl,
		readyPath: service.healthCheckPath ?? service.dataCheckPath,
	});
	if (booted) {
		await stopService(sandbox);
		failures.push(
			`${service.name}: did not boot against a real Postgres. ${booted}`,
		);
		return failures;
	}

	const probe = await probeService(sandbox, service.dataCheckPath);
	await stopService(sandbox);

	if (probe.status !== 200) {
		failures.push(
			`${service.name}: GET ${service.dataCheckPath} returned ${probe.status} against a real Postgres. ` +
				`Body:\n${probe.body.slice(0, 1_000)}`,
		);
	} else if (isEmptyPayload(probe.body)) {
		failures.push(
			`${service.name}: GET ${service.dataCheckPath} returned 200 but no data (${probe.body.slice(0, 200) || "empty body"}). ` +
				"The schema applied but nothing seeded it, so the deployed app will render an empty page. " +
				"Seed the tables from preDeployCommand.",
		);
	}

	return failures;
}

/** An endpoint that answers with nothing is the seed failing, not succeeding. */
function isEmptyPayload(body: string): boolean {
	const trimmed = body.trim();
	return (
		trimmed === "" ||
		trimmed === "[]" ||
		trimmed === "{}" ||
		/^\{\s*"\w+"\s*:\s*\[\s*\]\s*\}$/.test(trimmed)
	);
}

async function checkForPlaceholders(
	sandbox: Sandbox,
	dir: string,
): Promise<string[]> {
	const pattern =
		"lorem ipsum|coming soon|placeholder\\.com|via\\.placeholder|TODO:";
	const found = await sandbox.run(
		`grep -ril -E ${shellEscape(pattern)} ${shellEscape(dir)} || true`,
	);
	const files = found.output.trim();
	return files
		? [
				`Placeholder content reached the build output in ${files.split("\n").length} file(s). Replace it with real copy.`,
			]
		: [];
}

/**
 * Boot a service in the background and wait for it to answer. Returns null on
 * success, or the service log to report. The process outlives the exec that
 * started it, so callers can probe it over several requests before stopping
 * it; the sandbox is terminated in a `finally` regardless.
 */
async function startService(
	sandbox: Sandbox,
	serviceDir: string,
	startCommand: string,
	opts: { databaseUrl: string; readyPath: string },
): Promise<string | null> {
	const start =
		`cd ${shellEscape(serviceDir)} && rm -f /tmp/smoke.log && ` +
		`(nohup env PORT=${SMOKE_PORT} DATABASE_URL=${shellEscape(opts.databaseUrl)} ` +
		`${startCommand} >/tmp/smoke.log 2>&1 & echo $! >/tmp/smoke.pid) && ` +
		`for _ in $(seq 1 ${BOOT_ATTEMPTS}); do sleep 1; ` +
		`if curl -fsS -m 2 http://127.0.0.1:${SMOKE_PORT}${opts.readyPath} >/dev/null 2>&1; then ok=1; break; fi; done; ` +
		'if [ -z "$ok" ]; then echo "--- service log ---"; cat /tmp/smoke.log; exit 1; fi';

	const result = await sandbox.run(start);
	return result.exitCode === 0 ? null : result.output.slice(0, 2_000);
}

async function stopService(sandbox: Sandbox): Promise<void> {
	await sandbox
		.run('kill "$(cat /tmp/smoke.pid)" 2>/dev/null; rm -f /tmp/smoke.pid; true')
		.catch(() => {});
}

/** One request against the running service. */
async function probeService(
	sandbox: Sandbox,
	path: string,
): Promise<{ status: number; body: string }> {
	const result = await sandbox.run(
		`curl -sS -m 10 -o /tmp/probe.out -w '%{http_code}' ` +
			`http://127.0.0.1:${SMOKE_PORT}${path}; echo; head -c 4000 /tmp/probe.out`,
	);
	const [statusLine, ...rest] = result.output.split("\n");
	return {
		status: Number.parseInt(statusLine.trim(), 10) || 0,
		body: rest.join("\n"),
	};
}

function runBuilder(
	tasks: TaskContext,
	sandbox: Sandbox,
	appDir: string,
	message: string,
	stage: string,
): Promise<BuildOutput> {
	return agentJson(
		(text) =>
			tasks.run(buildTask, {
				message: text,
				sandboxId: sandbox.id,
				workDir: appDir,
			}),
		buildOutputSchema,
		message,
		stage,
	);
}

/* ── Publish ──────────────────────────────────────────────────────────── */

/**
 * Copy the files of the app out of the sandbox of the run, into a new clone
 * of the apps repository in a sandbox of its own. There, write factory.json,
 * the app's render.yaml and README, and the root Blueprint from the spec,
 * commit them with the app, and push. Render deploys the push, so the parent
 * starts this only after verify-app passes. Returns the pushed commit, or
 * null when no file changed.
 *
 * The builder can run any command in the sandbox of the run. A process that
 * it starts stays after the command, and it can change git itself. So the
 * GitHub token never goes into that sandbox, and publish-app reads the files
 * of the app from it only as data.
 *
 * Render does not retry it. A retry after the push finds nothing to commit,
 * and the run then ends as if the push changed no files.
 */
export const publishAppTask = task(
	{
		name: "publish-app",
		plan: "starter",
		timeoutSeconds: PUBLISH_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function publishApp(
		_tasks: TaskContext,
		input: PublishAppInput,
	): Promise<{ commit: string | null }> {
		const { sandboxId, spec, message } = publishAppInputSchema.parse(input);
		const repoUrl = appsRepo().url;
		const appDir = appPath(spec.user, spec.appName);
		// verify-app read the same files. An error here means that they
		// changed after it.
		const built = await readAppFiles(connectSandbox(sandboxId), appDir);
		if ("error" in built) {
			throw new Error(`publish-app did not copy the app. ${built.error}`);
		}
		const commit = await inAppsClone(PUBLISH_TIMEOUT_SECONDS, async (clone) => {
			await writeAppFiles(clone.sandbox, appDir, built.files);
			await writeBlueprints(clone.sandbox, spec, appDir, repoUrl);
			return commitAndPush(clone, spec, message);
		});
		console.log(
			JSON.stringify({
				event: "app_published",
				user: spec.user,
				appName: spec.appName,
				commit,
			}),
		);
		return { commit };
	},
);

async function writeBlueprints(
	sandbox: Sandbox,
	spec: AppSpec,
	appDir: string,
	repoUrl: string,
): Promise<void> {
	// The .gitignore comes with the files of the app. verify() writes it,
	// because it must build from the same files that this commit holds.
	await sandbox.writeFile(
		`${appDir}/factory.json`,
		`${JSON.stringify(spec, null, 2)}\n`,
	);
	await sandbox.writeFile(`${appDir}/render.yaml`, appBlueprint(spec));
	await sandbox.writeFile(`${appDir}/README.md`, appReadme(spec, repoUrl));

	await writeRootBlueprint(sandbox);
}

/**
 * Regenerate the repository-root Blueprint from every app's factory.json.
 *
 * Derived state, never merged: a concurrent run appends its own app to the
 * same file, so this is also what resolves a rebase conflict on it. Returns
 * the paths it owns, which is the contract pushVerified's resolver expects.
 *
 * It reads the specs from a clone that no agent used. In it, the builder
 * wrote only the files of its own app, and publish-app wrote its
 * factory.json.
 */
async function writeRootBlueprint(sandbox: Sandbox): Promise<string[]> {
	const specs = await readAllSpecs(sandbox);
	await sandbox.writeFile(
		`${factoryConfig.repoDir}/${factoryConfig.blueprintPath}`,
		rootBlueprint(specs),
	);
	return [factoryConfig.blueprintPath];
}

/**
 * The spec of each app in the clone. A spec counts only in the directory of
 * the app that it names, so a file in one app directory cannot declare the
 * resources of a different app.
 */
async function readAllSpecs(sandbox: Sandbox): Promise<AppSpec[]> {
	const root = `${factoryConfig.repoDir}/${factoryConfig.appsDir}`;
	const found = await sandbox.run(
		`find ${shellEscape(root)} -mindepth 3 -maxdepth 3 -name factory.json -print 2>/dev/null || true`,
	);

	const specs: AppSpec[] = [];
	for (const path of found.output.split("\n").map((line) => line.trim())) {
		if (!path.startsWith(`${root}/`)) continue;
		const raw = await sandbox.run(`cat ${shellEscape(path)}`);
		if (raw.exitCode !== 0) continue;
		try {
			const spec = appSpecSchema.parse(JSON.parse(raw.output));
			const [user, appName] = path.slice(root.length + 1).split("/");
			if (spec.user !== user || spec.appName !== appName) {
				console.warn(
					JSON.stringify({
						event: "skipped_app_spec",
						path,
						reason: `it names ${spec.user}/${spec.appName}`,
					}),
				);
				continue;
			}
			specs.push(spec);
		} catch {
			console.warn(JSON.stringify({ event: "skipped_app_spec", path }));
		}
	}
	return specs;
}

/** A sandbox that holds a clone of the apps repository, and how to push it. */
interface AppsClone {
	sandbox: Sandbox;
	token: string;
	remoteUrl: string;
}

/**
 * Clone the apps repository in a new sandbox, do the work, and terminate the
 * sandbox. No agent uses this sandbox, so the GitHub token can go into it.
 * The token comes just before the clone: an installation token expires after
 * an hour, and a run can take two hours.
 *
 * Each push makes its own clone, so it starts from the newest commit, and no
 * sandbox stays up while a run or the steps of a delete wait.
 */
async function inAppsClone<T>(
	timeoutSeconds: number,
	work: (clone: AppsClone) => Promise<T>,
): Promise<T> {
	const repo = appsRepo();
	const sandbox = await createSandbox({ timeoutSeconds });
	try {
		const token = await githubToken();
		const remoteUrl = await cloneAppsRepo(
			sandbox,
			token,
			repo,
			factoryConfig.branch,
		);
		return await work({ sandbox, token, remoteUrl });
	} finally {
		await sandbox
			.terminate()
			.catch((error) => console.error("Failed to terminate sandbox:", error));
	}
}

/**
 * Commit and push the changes of one app: its directory and the root
 * Blueprint. A commit that changes nothing is not made, and there is nothing
 * to push. Returns the commit that it pushed, or null.
 */
async function commitAndPush(
	clone: AppsClone,
	app: { user: string; appName: string },
	message: string,
): Promise<string | null> {
	const paths = [
		appRelativePath(app.user, app.appName),
		factoryConfig.blueprintPath,
	];
	if (!(await commitPaths(clone.sandbox, message, paths))) return null;
	return pushVerified(
		clone.sandbox,
		clone.token,
		clone.remoteUrl,
		factoryConfig.branch,
		paths,
		() => writeRootBlueprint(clone.sandbox),
	);
}

/* ── Deploy ───────────────────────────────────────────────────────────── */

export interface DeployContext {
	/** Runs the deploy manager, the builder, verify-app, and publish-app. */
	tasks: TaskContext;
	mcp: RenderMcp;
	sandbox: Sandbox;
	workspaceId: string;
	repoUrl: string;
	spec: AppSpec;
	appDir: string;
	runId: string;
	summary: string;
	databaseUrl: string | null;
}

/**
 * The deploy-manager loop. After the initial push:
 * 1. Wait for services to appear via Blueprint sync
 * 2. Wait for deploys to reach a terminal state
 * 3. If any fail, the deploy-manager agent diagnoses via MCP
 * 4. The builder fixes what the deploy-manager diagnosed
 * 5. verify-app verifies the repair. publish-app rewrites factory.json and
 *    the Blueprints from the repaired manifest, and pushes. Then wait for a
 *    new deploy of each service that failed. Repeat up to
 *    MAX_DEPLOY_REPAIR_ROUNDS
 */
export async function awaitDeployment(
	ctx: DeployContext,
): Promise<WorkflowResult> {
	const { mcp, workspaceId } = ctx;
	// A repair replaces the manifest. Read the spec from here, not from ctx.
	let spec = ctx.spec;
	const names = resourceNames(spec);
	const wanted = [...names.services.values()];
	const heartbeat = runHeartbeat(ctx.runId);

	// An error is not caught. awaiting_blueprint tells the user to create a
	// Blueprint, so only a lookup that finds none can give it. findBlueprint
	// tries a failed request again, and an error that stays ends the run with
	// that error as its summary.
	const blueprint = await findBlueprint({
		workspaceId,
		repo: ctx.repoUrl,
		branch: factoryConfig.branch,
		path: factoryConfig.blueprintPath,
	});
	if (!blueprint) {
		return {
			status: "awaiting_blueprint",
			user: spec.user,
			appName: spec.appName,
			summary: [
				ctx.summary,
				`Committed to ${ctx.repoUrl} on ${factoryConfig.branch}, but no Blueprint in workspace ${workspaceId} is watching ${factoryConfig.blueprintPath}.`,
				"Create one once in that workspace in the Render Dashboard (New > Blueprint) and every later run deploys on push.",
			].join("\n\n"),
		};
	}

	await setRunStage(
		ctx.runId,
		"waiting_for_services",
		`Waiting for ${wanted.length} Blueprint service(s)`,
	);
	const services = await waitForServices(
		mcp,
		workspaceId,
		wanted,
		SERVICE_TIMEOUT_MS,
		heartbeat,
	);
	if (services.size < wanted.length) {
		const missing = wanted.filter((name) => !services.has(name));
		return {
			status: "deploy_failed",
			summary: [
				`Blueprint ${blueprint.id} did not produce ${missing.join(", ")} within ${SERVICE_TIMEOUT_MS / 60000} minutes.`,
				blueprint.autoSync
					? `Blueprint status is "${blueprint.status}".`
					: "Auto Sync is off for this Blueprint, so the push did not sync. Turn it on or sync manually.",
			].join(" "),
		};
	}

	const urlOf = (name: string | null): string | null =>
		name ? (services.get(name)?.url ?? null) : null;

	await setRunUrls(ctx.runId, {
		webUrl: urlOf(names.web),
		apiUrl: urlOf(names.api),
	});

	// ── Deploy-manager loop ─────────────────────────────────────────────
	// The first round waits for every service. A repair round waits only for
	// the services that failed. A live service that the repair did not change
	// gets no new deploy, so it keeps its live deploy.
	let waits: DeployWait[] = [...services.values()].map((service) => ({
		service,
		after: null,
	}));
	for (let round = 0; round <= MAX_DEPLOY_REPAIR_ROUNDS; round++) {
		await setRunStage(
			ctx.runId,
			"waiting_for_deploys",
			`Waiting for ${waits.length} deploy(s), round ${round + 1}`,
		);
		const outcomes = await Promise.all(
			waits.map(async ({ service, after }) => ({
				service,
				deploy: await waitForDeploy(mcp, service.id, {
					workspaceId,
					timeoutMs: DEPLOY_TIMEOUT_MS,
					after,
					onPoll: (detail) => heartbeat(`${service.name}: ${detail}`),
				}),
			})),
		);

		const failed = outcomes.filter(({ deploy }) => deploy.result !== "live");
		if (failed.length === 0) break;

		// Another round cannot repair a service that the push did not deploy
		// again. The deploy manager reads the same failed deploy.
		if (
			round === MAX_DEPLOY_REPAIR_ROUNDS ||
			failed.some(({ deploy }) => deploy.result === "not_started")
		) {
			return { status: "deploy_failed", summary: deployFailures(failed) };
		}

		// Deploy-manager agent diagnoses the failure via Render MCP.
		const failureSummary = failed
			.map(
				({ service, deploy }) =>
					`Service "${service.name}" (${service.id}): deploy status "${deploy.status}"`,
			)
			.join("\n");

		const diagnosis = await agentJson(
			(message) => ctx.tasks.run(deployManagerTask, { message }),
			deployDiagnosisSchema,
			[
				`Workspace: ${workspaceId}`,
				"",
				"The following services failed to deploy:",
				failureSummary,
				"",
				"Use your Render MCP tools to inspect these services, find deploy logs, and diagnose exactly what went wrong.",
			].join("\n"),
			`deploy-manager-${round + 1}`,
		);

		if (diagnosis.allHealthy || diagnosis.failures.length === 0) break;

		// Hand the diagnosis to the builder to fix.
		const diagnosisText = diagnosis.failures
			.map(
				(f) =>
					`--- ${f.serviceName} (${f.status}) ---\n${f.diagnosis}${f.logs ? `\n\nLogs:\n${f.logs}` : ""}`,
			)
			.join("\n\n");

		const buildOutput = await runBuilder(
			ctx.tasks,
			ctx.sandbox,
			ctx.appDir,
			[
				"The app built and passed verification in the sandbox, but Render's deploy failed.",
				"The deploy manager diagnosed these issues:",
				"",
				diagnosisText,
				"",
				"Fix exactly what the diagnosis names.",
				"Keep the same services and databases in the manifest. Do not add, remove, or rename one, and do not change the kind of a service.",
			].join("\n"),
			`builder-deploy-fix-${round + 1}`,
		);

		// The repaired manifest goes to the sandbox and then to Render, so it
		// must pass the same policy as the first one. It must also keep every
		// resource, because `names` and `services` above describe them. The
		// rest of the spec stays: resourcePrefix is in each resource name.
		const repaired: AppSpec = { ...spec, manifest: buildOutput.manifest };
		const rejection =
			checkManifestCommands(repaired.manifest) ??
			resourceChange(spec, repaired);
		if (rejection) {
			return {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} was not pushed. ${rejection}`,
			};
		}

		const { failures } = await ctx.tasks.run(verifyAppTask, {
			sandboxId: ctx.sandbox.id,
			user: spec.user,
			appName: spec.appName,
			manifest: repaired.manifest,
			databaseUrl: ctx.databaseUrl,
		});
		if (failures.length > 0) {
			return {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} failed local verification: ${failures.join("; ").slice(0, 1_000)}`,
			};
		}

		// Render deploys from the root Blueprint, which comes from each
		// factory.json. If these files keep the old manifest, Render keeps the
		// old commands, paths, and env vars.
		spec = repaired;
		const { commit } = await ctx.tasks.run(publishAppTask, {
			sandboxId: ctx.sandbox.id,
			spec,
			message: `Fix Render deploy for ${spec.user}/${spec.appName} (round ${round + 1})`,
		});
		// With no commit, Render deploys nothing, and the failed deploys stay.
		// Render keeps the last live deploy of a failed service, so the smoke
		// checks can pass against the old code.
		if (!commit) {
			return {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} changed no files, so Render has no new commit to deploy. ${deployFailures(failed)}`,
			};
		}

		// Right after the push, the newest deploy of each failed service is
		// still the deploy that failed.
		waits = failed.map(({ service, deploy }) => ({
			service,
			after: deploy.deployId,
		}));
	}

	// ── Smoke the real thing ────────────────────────────────────────────
	await setRunStage(
		ctx.runId,
		"smoke_testing",
		"Deploys are live. The workflow checks public URLs, the API host in the storefront, data, and CORS",
	);
	const apiUrl = urlOf(names.api);
	// An API-only app has no storefront, so the API is the public URL.
	const webUrl = urlOf(names.web) ?? apiUrl;
	if (!webUrl) {
		return {
			status: "deploy_failed",
			summary: `${names.web ?? names.api} deployed but Render reported no public URL.`,
		};
	}

	const site = await waitForHttpOk(webUrl, SITE_TIMEOUT_MS, {
		onPoll: heartbeat,
	});
	if (!site.ok) {
		return {
			status: "deploy_failed",
			summary: `${webUrl} did not return a successful response (last status ${site.status}).`,
		};
	}

	const apiService = spec.manifest.services.find(
		(service) => service.kind === "web_service",
	);
	if (apiUrl && apiService) {
		const failure =
			(await smokeStorefront(urlOf(names.web), apiUrl)) ??
			(await smokeApi(apiUrl, apiService, urlOf(names.web), heartbeat));
		if (failure) {
			return {
				status: "deploy_failed",
				summary: `${failure}\n\nStorefront: ${webUrl}\nAPI: ${apiUrl}`,
			};
		}
	}

	const hasDb = (spec.manifest.databases ?? []).length > 0;

	return {
		status: "deployed",
		user: spec.user,
		appName: spec.appName,
		webUrl,
		apiUrl,
		summary: [
			ctx.summary,
			`Deployed ${[...services.values()].length} service(s)${hasDb ? " and a Postgres database" : ""} from ${factoryConfig.blueprintPath} (Blueprint ${blueprint.id}).`,
		].join("\n\n"),
	};
}

/** A service to wait for after a push. */
interface DeployWait {
	service: ServiceRecord;
	/** The deploy from before the push, or null. See waitForDeploy(). */
	after: string | null;
}

function deployFailures(
	failed: readonly { service: ServiceRecord; deploy: DeployOutcome }[],
): string {
	const lines = failed.map(({ service, deploy }) =>
		deploy.result === "not_started"
			? `${service.name}: the repair push did not start a new deploy in ${DEPLOY_TIMEOUT_MS / 60000} minutes. ` +
				`The newest deploy is still ${deploy.deployId} ("${deploy.status}").`
			: `${service.name} ended as "${deploy.status}".`,
	);
	if (failed.some(({ deploy }) => deploy.result === "not_started")) {
		lines.push(
			"Render deploys a service again when a commit changes files in its rootDir or its entry in the Blueprint.",
		);
	}
	return lines.join(" ");
}

/**
 * Why a repaired spec cannot replace the deployed one, or null when both
 * declare the same resources. A removed resource stays live outside the
 * Blueprint: Render does not delete it, and the factory calls no Render write
 * API. The deploy loop also cannot monitor an added resource, because it waits
 * only for the services of the first push.
 */
function resourceChange(deployed: AppSpec, repaired: AppSpec): string | null {
	const before = declaredResources(deployed);
	const after = declaredResources(repaired);
	const added = after.filter((resource) => !before.includes(resource));
	const removed = before.filter((resource) => !after.includes(resource));
	if (added.length === 0 && removed.length === 0) return null;

	const changes = [
		...(added.length > 0 ? [`adds ${added.join(", ")}`] : []),
		...(removed.length > 0 ? [`removes ${removed.join(", ")}`] : []),
	];
	return (
		`The repair ${changes.join(" and ")}. ` +
		"A repair can change commands, paths, and env vars, but not the resources that the Blueprint declares."
	);
}

/**
 * The build of the storefront writes the API hostname into its bundle, and
 * only a browser uses that hostname. The API checks cannot find a wrong
 * hostname: the private-network `host`, for example, passes all of them.
 */
async function smokeStorefront(
	webUrl: string | null,
	apiUrl: string,
): Promise<string | null> {
	if (!webUrl) return null;
	const apiHost = new URL(apiUrl).hostname;
	if (await pageContains(webUrl, apiHost)) return null;
	return (
		`${webUrl} does not contain the API hostname ${apiHost} in its HTML or in the scripts that it loads. ` +
		"A browser cannot find the API. Set the storefront env var with fromService envVarKey RENDER_EXTERNAL_HOSTNAME. " +
		"The host property is a name on the private network, and a browser cannot connect to it."
	);
}

/**
 * The checks a deploy status cannot make. "live" means the build succeeded and
 * the health check passed, and the health check is required not to touch the
 * database — so it certifies exactly the part that does not depend on
 * Postgres. Whether the API returns rows, and whether the storefront's origin
 * is allowed to read them, are facts about two services agreeing, invisible to
 * either one's status.
 */
async function smokeApi(
	apiUrl: string,
	service: Service,
	webOrigin: string | null,
	onPoll?: (detail: string) => void | Promise<void>,
): Promise<string | null> {
	const healthPath = service.healthCheckPath ?? "/health";
	const health = await waitForHttpOk(`${apiUrl}${healthPath}`, SITE_TIMEOUT_MS, {
		onPoll,
	});
	if (!health.ok) {
		return `${apiUrl}${healthPath} did not answer (last status ${health.status}).`;
	}

	if (!service.dataCheckPath) return null;

	const data = await waitForHttpOk(
		`${apiUrl}${service.dataCheckPath}`,
		SITE_TIMEOUT_MS,
		{
			headers: webOrigin ? { origin: webOrigin } : undefined,
			onPoll,
		},
	);
	if (!data.ok) {
		return (
			`${apiUrl}${service.dataCheckPath} did not answer (last status ${data.status}). ` +
			"The service is live, so its database wiring or its schema is the problem."
		);
	}

	// The storefront is a different origin on a different host, so a browser
	// drops the response without this header even though every server-side
	// check above passed.
	if (webOrigin) {
		const allowed = data.headers.get("access-control-allow-origin");
		if (!allowed || (allowed !== "*" && allowed !== webOrigin)) {
			return (
				`${apiUrl}${service.dataCheckPath} answered, but sent ` +
				`${allowed ? `access-control-allow-origin: ${allowed}` : "no access-control-allow-origin header"} ` +
				`for origin ${webOrigin}. The storefront cannot read the API from a browser.`
			);
		}
	}

	return null;
}

function runHeartbeat(runId: string): (detail: string) => Promise<void> {
	let lastUpdate = 0;
	return async (detail) => {
		if (Date.now() - lastUpdate < 30_000) return;
		lastUpdate = Date.now();
		await touchRun(runId, detail.slice(0, 500));
	};
}

/* ── Delete ───────────────────────────────────────────────────────────── */

interface DeleteResult {
	status: "deleted";
	user: string;
	appName: string;
	/** The Render resources that the delete removed. */
	deleted: string[];
}

/**
 * Render does not retry this task. A delete that fails marks the runs of the
 * app delete_failed, and a new request starts it again. Each step reads the
 * state that an earlier attempt left, so a new attempt does only what is left.
 */
export const deleteApp = task(
	{
		name: "delete-app",
		plan: "starter",
		timeoutSeconds: DELETE_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function deleteApp(
		tasks: TaskContext,
		rawInput: unknown,
	): Promise<DeleteResult> {
		const app = deleteAppInputSchema.parse(rawInput);

		try {
			const deleted = await removeApp(tasks, app);
			await deleteRuns(app.user, app.appName);
			console.log(JSON.stringify({ event: "app_deleted", ...app, deleted }));
			return { status: "deleted", ...app, deleted };
		} catch (error) {
			const summary = error instanceof Error ? error.message : String(error);
			console.error(
				JSON.stringify({ event: "app_delete_failed", ...app, error: summary }),
			);
			await failDelete(app.user, app.appName, summary.slice(0, 1_000)).catch(
				(storeError) =>
					console.error("Failed to record delete failure:", storeError),
			);
			throw error;
		}
	},
);

/**
 * Delete one app in the order that a Blueprint allows. A sync recreates a
 * declared resource that is missing, and it never deletes a resource that
 * leaves the file. So the first step takes the app out of the root Blueprint,
 * the resources are deleted when no sync of an earlier commit can run, and
 * the last step removes the files. Until then factory.json stays, with
 * deletedAt set, because a new attempt reads it to find the resources.
 *
 * Each step is a subtask. On Render, each one has its own run, with its
 * input, its result, and its logs.
 */
export async function removeApp(
	tasks: TaskContext,
	app: DeleteAppInput,
): Promise<string[]> {
	const removed = await tasks.run(removeFromBlueprintTask, app);
	let deleted: string[] = [];
	if (removed) {
		await tasks.run(waitForSyncsTask, { ...app, pushedAt: removed.pushedAt });
		deleted = await tasks.run(deleteResourcesTask, {
			...app,
			resourcePrefix: removed.resourcePrefix,
		});
	}
	await tasks.run(removeFilesTask, app);
	return deleted;
}

/**
 * The options of each step. Render does not retry a step: a failed step
 * fails the delete, and the next attempt starts again at the first step. A
 * retry of the first step after its push finds nothing to commit, so the wait
 * would not wait for the push event. A retry of the wait would give a sync
 * more time than SYNC_TIMEOUT_MS.
 */
const DELETE_STEP = {
	plan: "starter",
	timeoutSeconds: DELETE_STEP_TIMEOUT_SECONDS,
	retry: { maxRetries: 0, waitDurationMs: 0 },
};

interface RemovedFromBlueprint {
	/** As in factory.json. It is in the name of each Render resource of the app. */
	resourcePrefix: string;
	/** The commit that took the app out, or null if an earlier attempt pushed it. */
	commit: string | null;
	/** When this attempt pushed that commit, or null. */
	pushedAt: number | null;
}

/**
 * Write deletedAt into the app's factory.json, and push a root Blueprint that
 * leaves the app out. The commit changes only these two files: a commit that
 * removed the source of a service would start a build of it, and that build
 * would fail before the service is deleted.
 *
 * Returns null when the repository has no spec for the app. Only the spec
 * names the resources, so then no step deletes anything on Render.
 */
export const removeFromBlueprintTask = task(
	{ name: "remove-app-from-blueprint", ...DELETE_STEP },
	async function removeFromBlueprint(
		_tasks: TaskContext,
		input: DeleteAppInput,
	): Promise<RemovedFromBlueprint | null> {
		const { user, appName } = deleteAppInputSchema.parse(input);
		await setDeleteProgress(
			user,
			appName,
			"Removing the app from the Blueprint",
		);

		return inAppsClone(DELETE_STEP_TIMEOUT_SECONDS, async (clone) => {
			const spec = await readSpec(clone.sandbox, user, appName);
			if (!spec) {
				console.log(
					JSON.stringify({ event: "app_spec_not_found", user, appName }),
				);
				return null;
			}

			const deleting: AppSpec = {
				...spec,
				deletedAt: spec.deletedAt ?? new Date().toISOString(),
			};
			await clone.sandbox.writeFile(
				`${appPath(user, appName)}/factory.json`,
				`${JSON.stringify(deleting, null, 2)}\n`,
			);
			await writeRootBlueprint(clone.sandbox);
			const commit = await commitAndPush(
				clone,
				{ user, appName },
				`Delete ${user}/${appName}: remove it from the Blueprint`,
			);
			const pushedAt = commit ? Date.now() : null;
			console.log(
				JSON.stringify({
					event: "app_removed_from_blueprint",
					user,
					appName,
					deletedAt: deleting.deletedAt,
					commit,
				}),
			);
			return { resourcePrefix: spec.resourcePrefix, commit, pushedAt };
		});
	},
);

/**
 * Wait until no sync of the apps Blueprint waits or runs. When no Blueprint
 * watches the apps repository, no sync can bring a resource back, and there
 * is nothing to wait for.
 */
export const waitForSyncsTask = task(
	{ name: "wait-for-blueprint-syncs", ...DELETE_STEP },
	async function waitForSyncs(
		_tasks: TaskContext,
		input: WaitForSyncsInput,
	): Promise<{ blueprintId: string | null }> {
		const { user, appName, pushedAt } = waitForSyncsInputSchema.parse(input);
		const target = {
			workspaceId: renderWorkspaceId(),
			repo: appsRepo().url,
			branch: factoryConfig.branch,
			path: factoryConfig.blueprintPath,
		};
		// An error stops the delete. A delete without the wait for the
		// Blueprint lets a sync bring the resources back.
		const blueprint = await findBlueprint(target);
		if (!blueprint) {
			console.warn(JSON.stringify({ event: "blueprint_not_found", ...target }));
			return { blueprintId: null };
		}

		await waitForBlueprintSyncs(blueprint.id, {
			pushedAt,
			timeoutMs: SYNC_TIMEOUT_MS,
			onProgress: (detail) => setDeleteProgress(user, appName, detail),
		});
		return { blueprintId: blueprint.id };
	},
);

/** Delete the app's services, then its databases, then its project. */
export const deleteResourcesTask = task(
	{ name: "delete-app-resources", ...DELETE_STEP },
	async function deleteResources(
		_tasks: TaskContext,
		input: DeleteResourcesInput,
	): Promise<string[]> {
		const app = deleteResourcesInputSchema.parse(input);
		return deleteAppResources(app, {
			workspaceId: renderWorkspaceId(),
			onProgress: (detail) => setDeleteProgress(app.user, app.appName, detail),
		});
	},
);

/** Remove the app's directory from the apps repository. */
export const removeFilesTask = task(
	{ name: "remove-app-files", ...DELETE_STEP },
	async function removeFiles(
		_tasks: TaskContext,
		input: DeleteAppInput,
	): Promise<{ commit: string | null }> {
		const { user, appName } = deleteAppInputSchema.parse(input);
		await setDeleteProgress(
			user,
			appName,
			"Removing the app's files from the apps repository",
		);

		return inAppsClone(DELETE_STEP_TIMEOUT_SECONDS, async (clone) => {
			await clone.sandbox.mustRun(
				`rm -rf ${shellEscape(appPath(user, appName))}`,
				"Remove the app directory",
			);
			const commit = await commitAndPush(
				clone,
				{ user, appName },
				`Delete ${user}/${appName}`,
			);
			console.log(
				JSON.stringify({ event: "app_files_removed", user, appName, commit }),
			);
			return { commit };
		});
	},
);

/**
 * The spec of one app in the clone, or null when the repository has no spec
 * for it. The names of the resources to delete come from this file, so a
 * file that names a different app stops the delete.
 */
async function readSpec(
	sandbox: Sandbox,
	user: string,
	appName: string,
): Promise<AppSpec | null> {
	const path = `${appPath(user, appName)}/factory.json`;
	const exists = await sandbox.run(`test -e ${shellEscape(path)}`);
	if (exists.exitCode !== 0) return null;

	const raw = await sandbox.readFile(path);
	let value: unknown = null;
	try {
		value = JSON.parse(raw);
	} catch {
		// Reported below with the schema failure.
	}
	const parsed = appSpecSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.user !== user ||
		parsed.data.appName !== appName
	) {
		throw new Error(
			`${appRelativePath(user, appName)}/factory.json is not a valid spec of ${user}/${appName}, so the delete stopped.`,
		);
	}
	return parsed.data;
}

/* ── Prompts ──────────────────────────────────────────────────────────── */

function curatorMessage(plan: DeployPlan, appDir: string): string {
	return [
		`App: ${plan.appName}`,
		`What it is: ${plan.summary}`,
		"",
		`Call asset__collect once with destDir: ${assetsDir(appDir)}`,
		"and every subject below. Report paths as assets/<file>.",
		"",
		"Subjects to find:",
		...plan.assetQueries.map((query) => `- ${query}`),
	].join("\n");
}

/** Where the curator downloads to. The builder is told to use these. */
function assetsDir(appDir: string): string {
	return `${appDir}/assets`;
}

function builderMessage(opts: {
	prompt: string;
	plan: DeployPlan;
	appDir: string;
	assets: AssetManifest;
	databaseUrl: string | null;
	template: readonly string[];
}): string {
	const { plan } = opts;
	return [
		`Product prompt:\n${opts.prompt}`,
		"",
		`App directory: ${opts.appDir}`,
		opts.template.length > 0
			? "Commands and relative paths already start here; only what is in this directory ships."
			: [
					"Build the entire application from scratch in this directory. Commands and",
					"relative paths already start here; only what is in this directory ships.",
				].join("\n"),
		"",
		`Approved plan:\n${plan.summary}`,
		`Infrastructure: ${plan.tiers.map((t) => `${t.kind} (${t.reason})`).join(", ")}`,
		"",
		`Pages: ${plan.brief.pages.join(", ")}`,
		`Features: ${plan.brief.features.join(", ") || "none specified"}`,
		`Voice: ${plan.brief.voice}`,
		"",
		`Content direction:\n${plan.brief.content}`,
		...(plan.brief.dataModel ? [`Data model:\n${plan.brief.dataModel}`] : []),
		"",
		templateLines(opts.template),
		"",
		databaseLines(opts.databaseUrl),
		"",
		assetLines(opts.assets),
	].join("\n");
}

/**
 * The template is a working three-tier app, so the builder's job is to turn it
 * into the product rather than to reinvent the wiring. Spelling out the
 * manifest it corresponds to is the point: those exact values are what
 * verification and the Blueprint are built around.
 */
export function templateLines(template: readonly string[]): string {
	if (template.length === 0) {
		return "Skeleton: none. Choose your own stack and lay the app out yourself.";
	}
	return [
		"A working skeleton is already in the app directory. It builds, serves, and",
		"reads from Postgres as it stands — change it into the product rather than",
		"starting over, and keep the contracts it establishes.",
		"",
		"  web/  Vite + React + TypeScript + Tailwind v4, with shadcn/ui Button and",
		"        Card in src/components/ui and the cn() helper in src/lib/utils.ts.",
		"        src/lib/api.ts already builds the API base URL from VITE_API_HOST.",
		"  api/  Hono + node-postgres. CORS is on, GET /health answers without the",
		"        database, GET /api/items reads it. src/migrate.ts applies",
		"        sql/schema.sql and sql/seed.sql and is wired to npm run migrate.",
		"",
		"Both have a package-lock.json, so build with npm ci, not npm install.",
		"Rename the items table and the /api/items route to suit the product; edit",
		"sql/seed.sql to hold the real catalog from the brief.",
		"",
		"Return this manifest, adjusted only where you actually changed something:",
		"  web: static_site, rootDir web, build `npm ci && npm run build`,",
		"       staticPublishPath dist, envVar VITE_API_HOST fromService api",
		"       envVarKey RENDER_EXTERNAL_HOSTNAME. Do not use property host: a",
		"       browser cannot connect to that private-network name.",
		"  api: web_service, rootDir api, build `npm ci && npm run build`,",
		"       preDeployCommand `npm run migrate`, start `npm start`,",
		"       healthCheckPath /health, dataCheckPath /api/items,",
		"       envVar DATABASE_URL fromDatabase connectionString",
		`Files: ${template.join(", ")}`,
	].join("\n");
}

function databaseLines(databaseUrl: string | null): string {
	if (!databaseUrl) return "Database: none. Do not declare one in the manifest.";
	return [
		`Database: a real Postgres 18 is already running at ${databaseUrl}.`,
		"It is the same database your preDeployCommand and your service will use",
		"during verification, so develop against it — psql is on the PATH.",
		"Declare it in the manifest as a database, wire DATABASE_URL to it with",
		"fromDatabase, and set preDeployCommand and dataCheckPath on the service.",
	].join("\n");
}

/**
 * One line per photograph rather than the pretty-printed manifest. This text
 * rides along on every builder turn, so keeping it tight is worth it.
 */
function assetLines(assets: AssetManifest): string {
	if (assets.assets.length === 0) {
		return "Photographs: none available. Use inline SVG and CSS for all imagery.";
	}
	return [
		`Photographs already in ${"assets/"} (path | alt | credit to publish):`,
		...assets.assets.map(
			(asset) => `- ${asset.path} | ${asset.alt} | ${asset.credit}`,
		),
	].join("\n");
}

function appReadme(spec: AppSpec, repoUrl: string): string {
	const relative = appRelativePath(spec.user, spec.appName);
	return [
		`# ${spec.appName}`,
		"",
		spec.summary,
		"",
		`Generated by the Vibe Code factory from the prompt: "${oneLine(spec.prompt)}"`,
		"",
		"## Infrastructure",
		"",
		...declaredResources(spec).map((resource) => `- ${resource}`),
		"",
		"## Deploying this app on its own",
		"",
		"It is already deployed as part of the factory's Blueprint at the",
		"repository root. To run it as its own Blueprint instead, create a new",
		`Blueprint from ${repoUrl} with the Blueprint Path set to:`,
		"",
		"```text",
		`${relative}/render.yaml`,
		"```",
		"",
	].join("\n");
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").slice(0, 120);
}

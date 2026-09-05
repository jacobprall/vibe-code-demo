/** prompt-to-app — one API call to a deployed app on Render. */
import { task } from "@renderinc/sdk/workflows";
import {
	airoConfig,
	appPath,
	appRelativePath,
} from "../airo.config.js";
import {
	architectTask,
	buildTask,
	curatorTask,
	deployManagerTask,
} from "./agents.js";
import { appBlueprint, resourceNames, rootBlueprint } from "./blueprint.js";
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
	type DeployPlan,
	deployDiagnosisSchema,
	deployPlanSchema,
	type Service,
	type TierKind,
	type WorkflowResult,
	workflowInputSchema,
} from "./contracts.js";
import {
	cloneAppsRepo,
	commitAll,
	githubToken,
	pushVerified,
	runVerification,
} from "./git.js";
import { checkManifestCommands } from "./policy.js";
import {
	findBlueprint,
	RenderMcp,
	waitForDeploy,
	waitForHttpOk,
	waitForServices,
} from "./render.js";
import {
	createSandbox,
	ensureSandboxPostgres,
	type Sandbox,
	shellEscape,
} from "./sandbox.js";
import { finishRun, setRunApp, setRunStage, setRunUrls } from "./store.js";
import { materializeTemplate } from "./templates.js";

const SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;
const MAX_BUILD_ROUNDS = 2;
const MAX_DEPLOY_REPAIR_ROUNDS = 2;
const SERVICE_TIMEOUT_MS = 6 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const SITE_TIMEOUT_MS = 3 * 60 * 1000;
const SMOKE_PORT = 8099;
const BOOT_ATTEMPTS = 15;
/** Directory under templates/ that a multi-service app starts from. */
const FULLSTACK_TEMPLATE = "fullstack";
/** Proves a health endpoint answers before Postgres is reachable, as Render requires. */
const UNREACHABLE_DATABASE_URL = "postgres://unreachable/db";

export const promptToApp = task(
	{
		name: "prompt-to-app",
		plan: "standard",
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	},
	async function promptToApp(rawInput: unknown): Promise<WorkflowResult> {
		const { prompt, user, runId } = workflowInputSchema.parse(rawInput);

		try {
			const result = await run(prompt, user, runId);
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

/** The pipeline. */
async function run(
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
		(message) => architectTask({ message }),
		deployPlanSchema,
		`Product prompt:\n${prompt}`,
		"architect",
	);

	const appName = plan.appName;
	const blueprintPath = `${appRelativePath(user, appName)}/render.yaml`;
	await setRunApp(runId, { appName, blueprintPath });

	const sandbox = await createSandbox({
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	});
	try {
		const token = await githubToken();
		const remoteUrl = await cloneAppsRepo(
			sandbox,
			token,
			repo,
			airoConfig.branch,
		);
		const appDir = appPath(user, appName);
		// Every agent path resolves against this, so it has to exist first.
		await sandbox.mustRun(
			`mkdir -p ${shellEscape(appDir)}`,
			"Create app directory",
		);

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
		const assetManifest = await curate(sandbox, appDir, plan);

		// ── Build and verify ────────────────────────────────────────────
		await setRunStage(runId, "building");
		const built = await buildAndVerify({
			sandbox,
			appDir,
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

		const manifest = built.manifest;
		const tiers = manifestToTiers(manifest);
		const spec: AppSpec = {
			user,
			appName,
			prompt,
			summary: plan.summary,
			createdAt: new Date().toISOString(),
			tiers,
			manifest,
			notes: [],
		};

		// ── Publish ─────────────────────────────────────────────────────
		await setRunStage(runId, "publishing");
		await writeBlueprints(sandbox, spec, appDir, repo.url);
		const sha = await commitAll(
			sandbox,
			`${user}/${appName}: ${oneLine(prompt)}`,
		);
		if (!sha) {
			return { status: "build_failed", summary: "The run produced no files." };
		}
		await pushVerified(sandbox, token, remoteUrl, airoConfig.branch, () =>
			writeRootBlueprint(sandbox),
		);

		// ── Deploy ──────────────────────────────────────────────────────
		await setRunStage(runId, "deploying");
		return await awaitDeployment({
			mcp,
			sandbox,
			token,
			remoteUrl,
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

/** Derive the tiers list from the manifest for storage. */
function manifestToTiers(manifest: Manifest): TierKind[] {
	const tiers: TierKind[] = [];
	for (const service of manifest.services) {
		if (service.kind === "static_site" && !tiers.includes("static_site")) {
			tiers.push("static_site");
		}
		if (service.kind === "web_service" && !tiers.includes("web_service")) {
			tiers.push("web_service");
		}
	}
	if ((manifest.databases ?? []).length > 0) {
		tiers.push("postgres");
	}
	return tiers;
}

/* ── Imagery ──────────────────────────────────────────────────────────── */

/**
 * Photographs are decoration: the builder falls back to inline SVG and CSS
 * without them. So a curator that runs out of turns, or a Commons outage,
 * degrades the storefront rather than failing a deploy.
 */
async function curate(
	sandbox: Sandbox,
	appDir: string,
	plan: DeployPlan,
): Promise<AssetManifest> {
	if (plan.assetQueries.length === 0) return { assets: [] };

	try {
		return await agentJson(
			(message) =>
				curatorTask({ message, sandboxId: sandbox.id, workDir: appDir }),
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
	sandbox: Sandbox;
	appDir: string;
	plan: DeployPlan;
	prompt: string;
	runId: string;
	assets: AssetManifest;
	databaseUrl: string | null;
	template: readonly string[];
}): Promise<BuildOutcome> {
	let buildOutput = await runBuilder(
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
		const failures = await verify(
			opts.sandbox,
			opts.appDir,
			buildOutput.manifest,
			opts.databaseUrl,
		);
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
 * Generic verification driven by the manifest. For each service:
 * - Run the buildCommand in its rootDir
 * - For static sites: check staticPublishPath produced an index.html
 * - For web services with a healthCheckPath: boot it and curl the endpoint
 * - For web services with a dataCheckPath: migrate, boot against the sandbox's
 *   Postgres, and require the endpoint to answer with data
 * - Check for placeholder content in built output
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

	for (const service of manifest.services) {
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
	sandbox: Sandbox,
	appDir: string,
	message: string,
	stage: string,
): Promise<BuildOutput> {
	return agentJson(
		(text) =>
			buildTask({ message: text, sandboxId: sandbox.id, workDir: appDir }),
		buildOutputSchema,
		message,
		stage,
	);
}

/* ── Publish ──────────────────────────────────────────────────────────── */

async function writeBlueprints(
	sandbox: Sandbox,
	spec: AppSpec,
	appDir: string,
	repoUrl: string,
): Promise<void> {
	await sandbox.writeFile(
		`${appDir}/airo.json`,
		`${JSON.stringify(spec, null, 2)}\n`,
	);
	await sandbox.writeFile(`${appDir}/render.yaml`, appBlueprint(spec));
	await sandbox.writeFile(`${appDir}/README.md`, appReadme(spec, repoUrl));

	await writeRootBlueprint(sandbox);
}

/**
 * Regenerate the repository-root Blueprint from every app's airo.json.
 *
 * Derived state, never merged: a concurrent run appends its own app to the
 * same file, so this is also what resolves a rebase conflict on it. Returns
 * the paths it owns, which is the contract pushVerified's resolver expects.
 */
async function writeRootBlueprint(sandbox: Sandbox): Promise<string[]> {
	const specs = await readAllSpecs(sandbox);
	await sandbox.writeFile(
		`${airoConfig.repoDir}/${airoConfig.blueprintPath}`,
		rootBlueprint(specs),
	);
	return [airoConfig.blueprintPath];
}

async function readAllSpecs(sandbox: Sandbox): Promise<AppSpec[]> {
	const root = `${airoConfig.repoDir}/${airoConfig.appsDir}`;
	const found = await sandbox.run(
		`find ${shellEscape(root)} -mindepth 3 -maxdepth 3 -name airo.json -print 2>/dev/null || true`,
	);

	const specs: AppSpec[] = [];
	for (const path of found.output.split("\n").map((line) => line.trim())) {
		if (!path) continue;
		const raw = await sandbox.run(`cat ${shellEscape(path)}`);
		if (raw.exitCode !== 0) continue;
		try {
			specs.push(appSpecSchema.parse(JSON.parse(raw.output)));
		} catch {
			console.warn(JSON.stringify({ event: "skipped_app_spec", path }));
		}
	}
	return specs;
}

/* ── Deploy ───────────────────────────────────────────────────────────── */

interface DeployContext {
	mcp: RenderMcp;
	sandbox: Sandbox;
	token: string;
	remoteUrl: string;
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
 * 5. Re-verify, re-push, and repeat up to MAX_DEPLOY_REPAIR_ROUNDS
 */
async function awaitDeployment(ctx: DeployContext): Promise<WorkflowResult> {
	const { mcp, spec, workspaceId } = ctx;
	const names = resourceNames(spec);
	const wanted = [...names.services.values()];

	const blueprint = await findBlueprint({
		repo: ctx.repoUrl,
		branch: airoConfig.branch,
		path: airoConfig.blueprintPath,
	}).catch((error) => {
		console.error("Failed to look up the Blueprint:", error);
		return null;
	});
	if (!blueprint) {
		return {
			status: "awaiting_blueprint",
			user: spec.user,
			appName: spec.appName,
			summary: [
				ctx.summary,
				`Committed to ${ctx.repoUrl} on ${airoConfig.branch}, but no Blueprint is watching ${airoConfig.blueprintPath}.`,
				"Create one once in the Render Dashboard (New > Blueprint) and every later run deploys on push.",
				...spec.notes,
			].join("\n\n"),
		};
	}

	const services = await waitForServices(
		mcp,
		workspaceId,
		wanted,
		SERVICE_TIMEOUT_MS,
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
	for (let round = 0; round <= MAX_DEPLOY_REPAIR_ROUNDS; round++) {
		const outcomes = await Promise.all(
			[...services.values()].map(async (service) => ({
				service,
				deploy: await waitForDeploy(mcp, service.id, {
					workspaceId,
					timeoutMs: DEPLOY_TIMEOUT_MS,
				}),
			})),
		);

		const failed = outcomes.filter(({ deploy }) => !deploy.live);
		if (failed.length === 0) break;

		if (round === MAX_DEPLOY_REPAIR_ROUNDS) {
			return {
				status: "deploy_failed",
				summary: failed
					.map(
						({ service, deploy }) =>
							`${service.name} ended as "${deploy.status}".`,
					)
					.join(" "),
			};
		}

		// Deploy-manager agent diagnoses the failure via Render MCP.
		const failureSummary = failed
			.map(
				({ service, deploy }) =>
					`Service "${service.name}" (${service.id}): deploy status "${deploy.status}"`,
			)
			.join("\n");

		const diagnosis = await agentJson(
			(message) => deployManagerTask({ message }),
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
			ctx.sandbox,
			ctx.appDir,
			[
				"The app built and passed verification in the sandbox, but Render's deploy failed.",
				"The deploy manager diagnosed these issues:",
				"",
				diagnosisText,
				"",
				"Fix exactly what the diagnosis names.",
			].join("\n"),
			`builder-deploy-fix-${round + 1}`,
		);

		const failures = await verify(
			ctx.sandbox,
			ctx.appDir,
			buildOutput.manifest,
			ctx.databaseUrl,
		);
		if (failures.length > 0) {
			console.error(
				"Deploy repair failed verification:",
				failures.join("\n"),
			);
			return {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} failed local verification: ${failures.join("; ").slice(0, 1_000)}`,
			};
		}

		const sha = await commitAll(
			ctx.sandbox,
			`Fix Render deploy for ${spec.user}/${spec.appName} (round ${round + 1})`,
		);
		if (!sha) break;

		await pushVerified(
			ctx.sandbox,
			ctx.token,
			ctx.remoteUrl,
			airoConfig.branch,
			() => writeRootBlueprint(ctx.sandbox),
		);
	}

	// ── Smoke the real thing ────────────────────────────────────────────
	const apiUrl = urlOf(names.api);
	// An API-only app has no storefront, so the API is the public URL.
	const webUrl = urlOf(names.web) ?? apiUrl;
	if (!webUrl) {
		return {
			status: "deploy_failed",
			summary: `${names.web ?? names.api} deployed but Render reported no public URL.`,
		};
	}

	const site = await waitForHttpOk(webUrl, SITE_TIMEOUT_MS);
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
		const failure = await smokeApi(apiUrl, apiService, urlOf(names.web));
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
			`Deployed ${[...services.values()].length} service(s)${hasDb ? " and a Postgres database" : ""} from ${airoConfig.blueprintPath} (Blueprint ${blueprint.id}).`,
			...spec.notes,
		].join("\n\n"),
	};
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
): Promise<string | null> {
	const healthPath = service.healthCheckPath ?? "/health";
	const health = await waitForHttpOk(`${apiUrl}${healthPath}`, SITE_TIMEOUT_MS);
	if (!health.ok) {
		return `${apiUrl}${healthPath} did not answer (last status ${health.status}).`;
	}

	if (!service.dataCheckPath) return null;

	const data = await waitForHttpOk(
		`${apiUrl}${service.dataCheckPath}`,
		SITE_TIMEOUT_MS,
		webOrigin ? { headers: { origin: webOrigin } } : undefined,
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
function templateLines(template: readonly string[]): string {
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
		"       staticPublishPath dist, envVar VITE_API_HOST fromService api host",
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
		`Generated by the Airo factory from the prompt: "${oneLine(spec.prompt)}"`,
		"",
		"## Infrastructure",
		"",
		...spec.tiers.map((tier) => `- ${tier}`),
		...spec.notes.map((note) => `- ${note}`),
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

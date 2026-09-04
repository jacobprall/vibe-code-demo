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
	assetManifestSchema,
	buildOutputSchema,
	type DeployPlan,
	deployDiagnosisSchema,
	deployPlanSchema,
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
import { createSandbox, type Sandbox, shellEscape } from "./sandbox.js";
import { finishRun, setRunApp, setRunStage, setRunUrls } from "./store.js";

const SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;
const MAX_BUILD_ROUNDS = 2;
const MAX_DEPLOY_REPAIR_ROUNDS = 2;
const SERVICE_TIMEOUT_MS = 6 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const SITE_TIMEOUT_MS = 3 * 60 * 1000;
const SMOKE_PORT = 8099;

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

		// ── Imagery ─────────────────────────────────────────────────────
		await setRunStage(runId, "curating");
		const assetManifest = await agentJson(
			(message) => curatorTask({ message, sandboxId: sandbox.id }),
			assetManifestSchema,
			curatorMessage(plan, appDir),
			"curator",
		);

		// ── Build and verify ────────────────────────────────────────────
		await setRunStage(runId, "building");
		const built = await buildAndVerify({
			sandbox,
			appDir,
			plan,
			prompt,
			runId,
			assetManifest: JSON.stringify(assetManifest, null, 2),
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
		await pushVerified(sandbox, token, remoteUrl, airoConfig.branch);

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
	assetManifest: string;
}): Promise<BuildOutcome> {
	let buildOutput = await runBuilder(
		opts.sandbox,
		builderMessage(opts.prompt, opts.plan, opts.appDir, opts.assetManifest),
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
 * Generic verification driven by the manifest. For each service:
 * - Run the buildCommand in its rootDir
 * - For static sites: check staticPublishPath produced an index.html
 * - For web services with a healthCheckPath: boot it and curl the endpoint
 * - Check for placeholder content in built output
 */
async function verify(
	sandbox: Sandbox,
	appDir: string,
	manifest: Manifest,
): Promise<string[]> {
	const failures: string[] = [];

	for (const service of manifest.services) {
		const serviceDir = `${appDir}/${service.rootDir}`;

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
			const publishDir = `${serviceDir}/${service.staticPublishPath}`;
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

		if (service.kind === "web_service" && service.healthCheckPath) {
			const boot = await checkServiceBoots(
				sandbox,
				serviceDir,
				service.startCommand ?? "npm start",
				service.healthCheckPath,
			);
			failures.push(...boot);
		}
	}

	return failures;
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
 * Boot a web service with an unreachable database and confirm its health
 * endpoint responds. This mirrors what Render's health check does.
 */
async function checkServiceBoots(
	sandbox: Sandbox,
	serviceDir: string,
	startCommand: string,
	healthCheckPath: string,
): Promise<string[]> {
	const start =
		`cd ${shellEscape(serviceDir)} && ` +
		`(nohup env PORT=${SMOKE_PORT} DATABASE_URL=postgres://unreachable/db ` +
		`${startCommand} >/tmp/smoke.log 2>&1 & echo $! >/tmp/smoke.pid) && ` +
		"for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; " +
		`if curl -fsS -m 2 http://127.0.0.1:${SMOKE_PORT}${healthCheckPath} >/dev/null; then ok=1; break; fi; done; ` +
		'kill "$(cat /tmp/smoke.pid)" 2>/dev/null; ' +
		'if [ -z "$ok" ]; then echo "--- service log ---"; cat /tmp/smoke.log; exit 1; fi';

	const result = await sandbox.run(start);
	return result.exitCode === 0
		? []
		: [
				`Service did not serve GET ${healthCheckPath} within 10s:\n${result.output.slice(0, 2_000)}`,
			];
}

function runBuilder(
	sandbox: Sandbox,
	message: string,
	stage: string,
): Promise<BuildOutput> {
	return agentJson(
		(text) => buildTask({ message: text, sandboxId: sandbox.id }),
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

	const specs = await readAllSpecs(sandbox);
	await sandbox.writeFile(
		`${airoConfig.repoDir}/${airoConfig.blueprintPath}`,
		rootBlueprint(specs),
	);
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
	const wanted = [names.web, ...(names.api ? [names.api] : [])];

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

	await setRunUrls(ctx.runId, {
		webUrl: services.get(names.web)?.url ?? null,
		apiUrl: names.api ? (services.get(names.api)?.url ?? null) : null,
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
		);
	}

	// ── Smoke the real thing ────────────────────────────────────────────
	const webUrl = services.get(names.web)?.url;
	if (!webUrl) {
		return {
			status: "deploy_failed",
			summary: `${names.web} deployed but Render reported no public URL.`,
		};
	}

	const site = await waitForHttpOk(webUrl, SITE_TIMEOUT_MS);
	if (!site.ok) {
		return {
			status: "deploy_failed",
			summary: `${webUrl} did not return a successful response (last status ${site.status}).`,
		};
	}

	const apiUrl = names.api ? (services.get(names.api)?.url ?? null) : null;
	if (apiUrl) {
		const apiService = spec.manifest.services.find(
			(s) => s.kind === "web_service",
		);
		const healthPath = apiService?.healthCheckPath ?? "/health";
		const health = await waitForHttpOk(
			`${apiUrl}${healthPath}`,
			SITE_TIMEOUT_MS,
		);
		if (!health.ok) {
			return {
				status: "deploy_failed",
				summary: `${apiUrl}${healthPath} did not answer (last status ${health.status}).`,
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

/* ── Prompts ──────────────────────────────────────────────────────────── */

function curatorMessage(plan: DeployPlan, appDir: string): string {
	return [
		`App: ${plan.appName}`,
		`What it is: ${plan.summary}`,
		"",
		`Download images into: ${appDir}/public/assets`,
		"Report each path relative to that directory's parent, e.g. assets/walnut-chair.jpg.",
		"",
		"Subjects to find:",
		...plan.assetQueries.map((query) => `- ${query}`),
	].join("\n");
}

function builderMessage(
	prompt: string,
	plan: DeployPlan,
	appDir: string,
	assetManifest: string,
): string {
	return [
		`Product prompt:\n${prompt}`,
		"",
		`App directory: ${appDir}`,
		"Build the entire application from scratch in this directory.",
		"",
		`Approved plan:\n${plan.summary}`,
		`Infrastructure: ${plan.tiers.map((t) => `${t.kind} (${t.reason})`).join(", ")}`,
		"",
		`Pages: ${plan.brief.pages.join(", ")}`,
		`Features: ${plan.brief.features.join(", ") || "none specified"}`,
		`Voice: ${plan.brief.voice}`,
		"",
		`Content direction:\n${plan.brief.content}`,
		`Data model:\n${plan.brief.dataModel}`,
		"",
		`Asset manifest (images already downloaded):\n${assetManifest}`,
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

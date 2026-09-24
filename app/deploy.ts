/**
 * The deploy stage of prompt-to-app: wait for Render to deploy the push,
 * repair a failed deploy, and smoke-test the live app.
 */
import type { TaskContext } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../factory.config.js";
import { deployManagerTask } from "./agents.js";
import { declaredResources, resourceNames } from "./blueprint.js";
import { runBuilder } from "./build.js";
import { agentJson } from "./claude.js";
import {
	type AppSpec,
	deployDiagnosisSchema,
	type Service,
	type WorkflowResult,
} from "./contracts.js";
import { publishAppTask } from "./publish.js";
import {
	type DeployOutcome,
	findBlueprint,
	pageContains,
	type ServiceRecord,
	waitForDeploy,
	waitForHttpOk,
	waitForServices,
} from "./render.js";
import type { Sandbox } from "./sandbox.js";
import { setRunStage, setRunUrls, touchRun } from "./store.js";
import { verifyAppTask } from "./verify.js";

const MAX_DEPLOY_REPAIR_ROUNDS = 2;
const SERVICE_TIMEOUT_MS = 6 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const SITE_TIMEOUT_MS = 3 * 60 * 1000;

export interface DeployContext {
	/** Runs the deploy manager, the builder, verify-app, and publish-app. */
	tasks: TaskContext;
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
	const { workspaceId } = ctx;
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
				deploy: await waitForDeploy(service.id, {
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

		// The repaired manifest must keep every resource, because `names` and
		// `services` above describe them. The rest of the spec stays:
		// resourcePrefix is in each resource name.
		const repaired: AppSpec = { ...spec, manifest: buildOutput.manifest };
		const rejection = resourceChange(spec, repaired);
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

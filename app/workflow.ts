/**
 * prompt-to-app — one API call to a deployed app on Render.
 * delete-app — one API call to remove that app again.
 *
 * Each stage is one call here. Its detail is in the module of the stage:
 * build, verify, publish, deploy, or delete.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import {
	appPath,
	appRelativePath,
	factoryConfig,
} from "../factory.config.js";
import { architectTask } from "./agents.js";
import { buildAndVerify } from "./build.js";
import { agentJson } from "./claude.js";
import { appsRepo, renderWorkspaceId } from "./config.js";
import {
	type AppSpec,
	type DeleteAppInput,
	deleteAppInputSchema,
	deployPlanSchema,
	type WorkflowResult,
	workflowInputSchema,
} from "./contracts.js";
import {
	DELETE_STEP_TIMEOUT_SECONDS,
	deleteResourcesTask,
	removeFilesTask,
	removeFromBlueprintTask,
	waitForSyncsTask,
} from "./delete.js";
import { awaitDeployment } from "./deploy.js";
import { initAppDir } from "./git.js";
import { collectImages } from "./images.js";
import { oneLine, publishAppTask } from "./publish.js";
import { createSandbox, ensureSandboxPostgres } from "./sandbox.js";
import {
	claimRunApp,
	deleteRuns,
	failDelete,
	finishRun,
	setRunStage,
} from "./store.js";
import { materializeTemplate } from "./templates.js";

const SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;
/** Directory under templates/ that a multi-service app starts from. */
const FULLSTACK_TEMPLATE = "fullstack";
/** delete-app waits for its four steps. */
const DELETE_TIMEOUT_SECONDS = 4 * DELETE_STEP_TIMEOUT_SECONDS;

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
		const images = await collectImages(sandbox, appDir, plan.assetQueries);

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
			images,
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
		return await awaitDeployment({
			tasks,
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

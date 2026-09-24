/**
 * The public API.
 *
 * The gateway runs no models, creates or deletes no infrastructure, and holds
 * no repository credential. It authenticates the caller, claims the run in
 * Postgres, and dispatches a prompt, or the delete of the run's app.
 */
import { randomUUID } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Render } from "@renderinc/sdk";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { factoryConfig } from "../factory.config.js";
import { apiKey, uiCredentials } from "./config.js";
import { createAppRequestSchema } from "./contracts.js";
import { redactSecrets } from "./policy.js";
import { workflowIdOfTaskRun } from "./render.js";
import {
	claimDelete,
	claimRun,
	claimWorkflowCheck,
	deleteRunWithoutApp,
	failDelete,
	finishRun,
	getRun,
	listRunsByUser,
	ping,
	type RunRecord,
	setDeleteWorkflowRunId,
	setWorkflowRunId,
} from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;
const RUN_ID = /^[0-9a-f-]{36}$/;
const TASK_NAME = "prompt-to-app";
const DELETE_TASK_NAME = "delete-app";
const UNAUTHORIZED = { error: "unauthorized" };
const DASHBOARD = "https://dashboard.render.com";
/** A failed read of the workflow ID is tried again after this, not on each poll. */
const WORKFLOW_ID_RETRY_MS = 60_000;

/** The ID of the workflow for links to the Render Dashboard, if it is known. */
type WorkflowIdReader = (taskRunId: string | null) => string | null;

export function createGateway(): Hono {
	const app = new Hono();
	const credentials = uiCredentials();
	const uiAuth: MiddlewareHandler =
		process.env.NODE_ENV !== "production" &&
		process.env.UI_AUTH_DISABLED === "true"
			? async (_c, next) => next()
			: basicAuth(credentials);
	// bearerAuth hashes both tokens and compares them in constant time.
	const apiAuth = bearerAuth({
		token: apiKey(),
		noAuthenticationHeaderMessage: UNAUTHORIZED,
		invalidAuthenticationHeaderMessage: {
			error: "invalid authorization header",
		},
		invalidTokenMessage: UNAUTHORIZED,
	});
	// It runs before the handler parses the body.
	const capBody = bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json({ error: "payload too large" }, 413),
	});
	const workflowId = workflowIdReader();

	app.get("/health", (c) => c.json({ status: "ok" }));

	app.get("/ready", async (c) => {
		try {
			await ping();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "unavailable" }, 503);
		}
	});

	app.use("/v1/*", apiAuth);
	app.post("/v1/apps", capBody, (c) => createRun(c, "/v1/apps"));
	app.get("/v1/apps/:runId", (c) => readRun(c, workflowId));
	app.delete("/v1/apps/:runId", (c) => deleteRun(c, "/v1/apps"));

	app.use("/ui/*", uiAuth);
	app.get("/ui/apps", (c) => listRuns(c, credentials.username, workflowId));
	app.post("/ui/apps", capBody, (c) =>
		createRun(c, "/ui/apps", credentials.username),
	);
	app.get("/ui/apps/:runId", (c) => readRun(c, workflowId));
	app.delete("/ui/apps/:runId", (c) =>
		deleteRun(c, "/ui/apps", credentials.username),
	);
	// Two views of the same UI. Each one has a button that opens the other.
	app.get("/", uiAuth, serveStatic({ path: "./public/index.html" }));
	app.get("/table", uiAuth, serveStatic({ path: "./public/table.html" }));
	app.get("/app.js", uiAuth, serveStatic({ path: "./public/app.js" }));
	app.get("/table.js", uiAuth, serveStatic({ path: "./public/table.js" }));
	app.get("/runs.js", uiAuth, serveStatic({ path: "./public/runs.js" }));
	app.get("/style.css", uiAuth, serveStatic({ path: "./public/style.css" }));

	return app;
}

/**
 * The UI polls only this list, also while runs build in parallel. So the list
 * reconciles each run that a task owns, as a read of one run does.
 */
async function listRuns(
	c: Context,
	user: string,
	workflowId: WorkflowIdReader,
): Promise<Response> {
	try {
		let runs = await listRunsByUser(user);
		const owned = runs.filter(ownedByTask);
		if (owned.length > 0) {
			await Promise.all(owned.map(reconcileWorkflowRun));
			runs = await listRunsByUser(user);
		}
		const id = workflowId(
			runs.find((run) => run.workflowRunId)?.workflowRunId ?? null,
		);
		return c.json({ runs: runs.map((run) => runResponse(run, id)) });
	} catch (error) {
		console.error("Failed to list runs:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
}

/**
 * Claim a run and dispatch prompt-to-app. `statusBase` is the route prefix of
 * the caller. The UI gives `userOverride`, the namespace of its Basic Auth
 * user, because a browser must not choose one.
 */
async function createRun(
	c: Context,
	statusBase: string,
	userOverride?: string,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = await c.req.json();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	const request = createAppRequestSchema.safeParse(
		userOverride && parsed && typeof parsed === "object"
			? { ...parsed, user: userOverride }
			: parsed,
	);
	if (!request.success) {
		return c.json(
			{
				error: "invalid request",
				detail: "prompt must be 8-2000 characters; user must be a lowercase slug",
			},
			400,
		);
	}

	const runId = randomUUID();
	const { prompt, user, idempotencyKey = runId } = request.data;
	let claim: Awaited<ReturnType<typeof claimRun>>;
	try {
		claim = await claimRun({ id: runId, idempotencyKey, prompt, user });
	} catch (error) {
		console.error("Failed to claim run:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
	if (!claim.claimed) {
		return claim.reason === "duplicate"
			? c.json({ runId: claim.runId, duplicate: true }, 200)
			: c.json(
					{
						error: "too many concurrent runs",
						detail: `The factory builds at most ${factoryConfig.maxConcurrentRuns} apps at a time, for all users. Submit the prompt again when a run finishes.`,
					},
					429,
				);
	}

	const workflowRunId = await dispatchWorkflow(TASK_NAME, {
		prompt,
		user,
		runId,
	});
	if (!workflowRunId) {
		await finishRun(runId, "failed", { summary: "dispatch failed" }).catch(
			(error) => console.error("Failed to release run claim:", error),
		);
		return c.json({ error: "dispatch failed" }, 502);
	}
	await setWorkflowRunId(runId, workflowRunId).catch((error) =>
		console.error("Failed to save workflow run id:", error),
	);

	return c.json(
		{ runId, user, status: "running", statusUrl: `${statusBase}/${runId}` },
		202,
	);
}

async function readRun(
	c: Context,
	workflowId: WorkflowIdReader,
): Promise<Response> {
	const runId = c.req.param("runId");
	if (!runId || !RUN_ID.test(runId)) return c.json({ error: "not found" }, 404);

	try {
		let run = await getRun(runId);
		if (!run) return c.json({ error: "not found" }, 404);
		if (ownedByTask(run)) {
			await reconcileWorkflowRun(run);
			const current = await getRun(runId);
			// A delete that finished removed the run.
			if (!current) return c.json({ error: "not found" }, 404);
			run = current;
		}
		return c.json(runResponse(run, workflowId(run.workflowRunId)));
	} catch (error) {
		console.error("Failed to read run:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
}

/**
 * Delete a run and the app that it built. The runs of one app share its files
 * and resources, so they are deleted together. This claims the runs and
 * dispatches the delete-app task, which does the work.
 */
async function deleteRun(
	c: Context,
	statusBase: string,
	namespace?: string,
): Promise<Response> {
	const runId = c.req.param("runId");
	if (!runId || !RUN_ID.test(runId)) return c.json({ error: "not found" }, 404);

	try {
		const run = await getRun(runId);
		// The UI can delete only the runs in its own namespace.
		if (!run || (namespace && run.user !== namespace)) {
			return c.json({ error: "not found" }, 404);
		}

		if (!run.appName) {
			// A run that did not choose an app created nothing but its row.
			return (await deleteRunWithoutApp(run.id))
				? c.json({ runId, status: "deleted" }, 200)
				: c.json({ error: "the run is still running" }, 409);
		}

		const appName = run.appName;
		const accepted = (runIds: string[]) =>
			c.json(
				{
					runId,
					status: "deleting",
					appName,
					runIds,
					statusUrl: `${statusBase}/${runId}`,
				},
				202,
			);

		const claim = await claimDelete(run.user, appName);
		if (!claim.claimed) {
			if (claim.reason === "missing")
				return c.json({ error: "not found" }, 404);
			if (claim.reason === "running") {
				return c.json({ error: "a run of this app is still running" }, 409);
			}
			// A delete is already in progress, so there is nothing to dispatch.
			return accepted(claim.runIds);
		}

		const workflowRunId = await dispatchWorkflow(DELETE_TASK_NAME, {
			user: run.user,
			appName,
		});
		if (!workflowRunId) {
			await failDelete(
				run.user,
				appName,
				"The delete did not start, because dispatch failed. Nothing was deleted.",
			).catch((error) =>
				console.error("Failed to release delete claim:", error),
			);
			return c.json({ error: "dispatch failed" }, 502);
		}
		await setDeleteWorkflowRunId(run.user, appName, workflowRunId).catch(
			(error) => console.error("Failed to save workflow run id:", error),
		);
		return accepted(claim.runIds);
	} catch (error) {
		console.error("Failed to delete run:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
}

export interface RunResponse {
	runId: string;
	status: string;
	stage: string | null;
	progress: string | null;
	prompt: string;
	user: string;
	appName: string | null;
	urls: { web: string | null; api: string | null };
	blueprintPath: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	/** When the run stopped, or null while it runs. */
	finishedAt: string | null;
	/** Pages in the Render Dashboard, or null for a link that cannot be made yet. */
	links: { workflowRun: string | null; sandbox: string | null };
}

/**
 * The public shape of a run. Summaries are model text, and progress can hold
 * the error of a failed Render read, so redact both.
 */
export function runResponse(
	run: RunRecord,
	workflowId: string | null = null,
): RunResponse {
	return {
		runId: run.id,
		status: run.status,
		stage: run.stage,
		progress: run.progress ? redactSecrets(run.progress) : null,
		prompt: run.prompt,
		user: run.user,
		appName: run.appName,
		urls: { web: run.webUrl, api: run.apiUrl },
		blueprintPath: run.blueprintPath,
		summary: run.summary ? redactSecrets(run.summary) : null,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		finishedAt: run.finishedAt,
		links: {
			// The task run that owns the status: prompt-to-app, or delete-app while
			// the app is deleted. The Dashboard shows the subtasks of a run on its
			// page. The SDK does not give the ID of a subtask run.
			workflowRun:
				workflowId && run.workflowRunId
					? `${DASHBOARD}/wf/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(run.workflowRunId)}`
					: null,
			sandbox:
				run.sandboxGroupId && run.sandboxId
					? `${DASHBOARD}/sandbox-group/${encodeURIComponent(run.sandboxGroupId)}/sandboxes/${encodeURIComponent(run.sandboxId)}`
					: null,
		},
	};
}

/**
 * Every task run of the factory belongs to the same workflow, so the gateway
 * reads its ID once, from the task run of any run. The read does not delay a
 * response: until it is done, the responses have no workflow link. A local
 * task run is not in the Dashboard, so local development gets no workflow
 * links.
 */
function workflowIdReader(): WorkflowIdReader {
	let workflowId: string | null = null;
	let reading = false;
	return (taskRunId) => {
		if (
			workflowId ||
			reading ||
			!taskRunId ||
			process.env.RENDER_USE_LOCAL_DEV === "true"
		) {
			return workflowId;
		}
		reading = true;
		workflowIdOfTaskRun(taskRunId).then(
			(id) => {
				workflowId = id;
			},
			(error) => {
				console.error("Failed to read the workflow ID:", error);
				setTimeout(() => {
					reading = false;
				}, WORKFLOW_ID_RETRY_MS).unref();
			},
		);
		return null;
	};
}

/** A task run owns the status of this run: prompt-to-app or delete-app. */
function ownedByTask(run: RunRecord): boolean {
	return (
		(run.status === "running" || run.status === "deleting") &&
		Boolean(run.workflowRunId)
	);
}

/**
 * A timeout, a crash, or a cancel stops a task before its own catch block,
 * so its row stays running or deleting. Mark that row failed. A task that
 * succeeds writes its result before it returns, so it needs nothing here.
 */
async function reconcileWorkflowRun(run: RunRecord): Promise<void> {
	if (!run.workflowRunId || !(await claimWorkflowCheck(run.id))) return;

	try {
		const taskRun = await new Render().workflows.getTaskRun(run.workflowRunId);
		if (taskRun.status !== "failed" && taskRun.status !== "canceled") return;

		const error = taskRun.error ?? "no error was reported";
		if (run.status === "deleting") {
			// A delete that succeeded removed the rows. Only a failure is left.
			if (run.appName) {
				await failDelete(
					run.user,
					run.appName,
					`Delete ${taskRun.status}: ${error}`,
					run.workflowRunId,
				);
			}
			return;
		}
		await finishRun(run.id, "failed", {
			summary: `Workflow ${taskRun.status}: ${error}`,
		});
	} catch (error) {
		// Reconciliation is a safety net. A transient SDK failure must not hide
		// the latest durable status already stored in Postgres.
		console.error("Failed to reconcile workflow run:", error);
	}
}

/** Start a Render Workflows task by name. */
export async function dispatchWorkflow(
	taskName: string,
	payload: Record<string, string>,
): Promise<string | null> {
	const slug = process.env.RENDER_WORKFLOW_SLUG;
	if (!slug) {
		console.error(`RENDER_WORKFLOW_SLUG not set — cannot dispatch ${taskName}`);
		return null;
	}

	try {
		const started = await new Render().workflows.startTask(
			`${slug}/${taskName}`,
			[payload],
		);
		return started.taskRunId;
	} catch (error) {
		console.error(`Failed to dispatch ${taskName}:`, error);
		return null;
	}
}

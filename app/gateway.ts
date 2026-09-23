/**
 * The public API.
 *
 * The gateway runs no models, creates or deletes no infrastructure, and holds
 * no repository credential. It authenticates the caller, claims the run in
 * Postgres, and dispatches a prompt, or the delete of the run's app.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import { apiKey, uiCredentials } from "./config.js";
import {
	createAppRequestSchema,
	type WorkflowResult,
} from "./contracts.js";
import { redactSecrets } from "./policy.js";
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
	reopenPausedRun,
	type RunRecord,
	setDeleteWorkflowRunId,
	setRunApp,
	setRunUrls,
	setWorkflowRunId,
} from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;
const RUN_ID = /^[0-9a-f-]{36}$/;
const TASK_NAME = "prompt-to-app";
const DELETE_TASK_NAME = "delete-app";

export function createGateway(): Hono {
	const app = new Hono();
	const credentials = uiCredentials();
	const uiAuth: MiddlewareHandler =
		process.env.NODE_ENV !== "production" &&
		process.env.UI_AUTH_DISABLED === "true"
			? async (_c, next) => next()
			: basicAuth(credentials);

	app.get("/health", (c) => c.json({ status: "ok" }));

	app.get("/ready", async (c) => {
		try {
			await ping();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "unavailable" }, 503);
		}
	});

	app.post("/v1/apps", (c) => createRun(c, true));
	app.get("/v1/apps/:runId", (c) => readRun(c, true));
	app.delete("/v1/apps/:runId", (c) => deleteRun(c, true));

	app.use("/ui/*", uiAuth);
	app.get("/ui/apps", (c) => listRuns(c, credentials.username));
	app.post("/ui/apps", (c) => createRun(c, false, credentials.username));
	app.get("/ui/apps/:runId", (c) => readRun(c, false));
	app.delete("/ui/apps/:runId", (c) =>
		deleteRun(c, false, credentials.username),
	);
	app.get("/", uiAuth, serveStatic({ path: "./public/index.html" }));
	app.get("/app.js", uiAuth, serveStatic({ path: "./public/app.js" }));
	app.get("/style.css", uiAuth, serveStatic({ path: "./public/style.css" }));

	return app;
}

async function listRuns(c: Context, user: string): Promise<Response> {
	try {
		const runs = await listRunsByUser(user);
		return c.json({ runs: runs.map(runResponse) });
	} catch (error) {
		console.error("Failed to list runs:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
}

async function createRun(
	c: Context,
	requireBearer: boolean,
	userOverride?: string,
): Promise<Response> {
	if (requireBearer && !authorized(c.req.raw.headers)) {
		return c.json({ error: "unauthorized" }, 401);
	}

	const body = await readBody(c.req.raw);
	if (body === null) return c.json({ error: "payload too large" }, 413);

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
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
			: c.json({ error: "too many concurrent runs" }, 429);
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

	const statusBase = requireBearer ? "/v1/apps" : "/ui/apps";
	return c.json(
		{ runId, user, status: "running", statusUrl: `${statusBase}/${runId}` },
		202,
	);
}

async function readRun(c: Context, requireBearer: boolean): Promise<Response> {
	if (requireBearer && !authorized(c.req.raw.headers)) {
		return c.json({ error: "unauthorized" }, 401);
	}

	const runId = c.req.param("runId");
	if (!runId || !RUN_ID.test(runId)) return c.json({ error: "not found" }, 404);

	try {
		let run = await getRun(runId);
		if (!run) return c.json({ error: "not found" }, 404);
		if (
			run.status === "failed" &&
			run.summary?.startsWith("Workflow paused:")
		) {
			await reopenPausedRun(run.id);
			run = (await getRun(runId)) ?? run;
		}
		if (
			(run.status === "running" || run.status === "deleting") &&
			run.workflowRunId
		) {
			await reconcileWorkflowRun(run);
			const current = await getRun(runId);
			// A delete that finished removed the run.
			if (!current) return c.json({ error: "not found" }, 404);
			run = current;
		}
		return c.json(runResponse(run));
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
	requireBearer: boolean,
	namespace?: string,
): Promise<Response> {
	if (requireBearer && !authorized(c.req.raw.headers)) {
		return c.json({ error: "unauthorized" }, 401);
	}

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
		const statusBase = requireBearer ? "/v1/apps" : "/ui/apps";
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
}

/** The public shape of a run. Summaries are model text, so redact them. */
export function runResponse(run: RunRecord): RunResponse {
	return {
		runId: run.id,
		status: run.status,
		stage: run.stage,
		progress: run.progress,
		prompt: run.prompt,
		user: run.user,
		appName: run.appName,
		urls: { web: run.webUrl, api: run.apiUrl },
		blueprintPath: run.blueprintPath,
		summary: run.summary ? redactSecrets(run.summary) : null,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}

async function reconcileWorkflowRun(run: RunRecord): Promise<void> {
	if (!run.workflowRunId || !(await claimWorkflowCheck(run.id))) return;

	try {
		const { Render } = await import("@renderinc/sdk");
		const taskRun = await new Render().workflows.getTaskRun(run.workflowRunId);
		if (run.status === "deleting") {
			// A delete that succeeded removed the rows. Only a failure is left.
			if (
				run.appName &&
				(taskRun.status === "failed" || taskRun.status === "canceled")
			) {
				await failDelete(
					run.user,
					run.appName,
					`Delete ${taskRun.status}: ${taskRun.error ?? "no error was reported"}`,
					run.workflowRunId,
				);
			}
			return;
		}

		if (taskRun.status === "succeeded" || taskRun.status === "completed") {
			const result = workflowResult(taskRun.results?.[0]);
			if (result) {
				await recoverWorkflowResult(run, result);
				return;
			}
			await finishRun(run.id, "failed", {
				summary: "Workflow completed without a valid terminal result.",
			});
			return;
		}

		if (taskRun.status === "failed" || taskRun.status === "canceled") {
			await finishRun(run.id, "failed", {
				summary: `Workflow ${taskRun.status}: ${taskRun.error ?? "no error was reported"}`,
			});
		}
	} catch (error) {
		// Reconciliation is a safety net. A transient SDK failure must not hide
		// the latest durable status already stored in Postgres.
		console.error("Failed to reconcile workflow run:", error);
	}
}

async function recoverWorkflowResult(
	run: RunRecord,
	result: WorkflowResult,
): Promise<void> {
	if (result.status === "deployed") {
		if (run.blueprintPath) {
			await setRunApp(run.id, {
				appName: result.appName,
				blueprintPath: run.blueprintPath,
			});
		}
		await setRunUrls(run.id, {
			webUrl: result.webUrl,
			apiUrl: result.apiUrl,
		});
	}
	await finishRun(run.id, result.status, { summary: result.summary });
}

function workflowResult(value: unknown): WorkflowResult | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.status !== "string" || typeof candidate.summary !== "string") {
		return null;
	}
	if (
		candidate.status === "build_failed" ||
		candidate.status === "deploy_failed" ||
		candidate.status === "failed"
	) {
		return { status: candidate.status, summary: candidate.summary };
	}
	if (
		candidate.status === "awaiting_blueprint" &&
		typeof candidate.user === "string" &&
		typeof candidate.appName === "string"
	) {
		return {
			status: candidate.status,
			user: candidate.user,
			appName: candidate.appName,
			summary: candidate.summary,
		};
	}
	if (
		candidate.status === "deployed" &&
		typeof candidate.user === "string" &&
		typeof candidate.appName === "string" &&
		typeof candidate.webUrl === "string" &&
		(candidate.apiUrl === null || typeof candidate.apiUrl === "string")
	) {
		return {
			status: candidate.status,
			user: candidate.user,
			appName: candidate.appName,
			webUrl: candidate.webUrl,
			apiUrl: candidate.apiUrl,
			summary: candidate.summary,
		};
	}
	return null;
}

/**
 * Bearer check. Both sides are digested first so the comparison is
 * constant-time regardless of the token lengths involved.
 */
export function authorized(headers: Headers): boolean {
	const header = headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return false;

	const presented = digest(header.slice("Bearer ".length).trim());
	const expected = digest(apiKey());
	return timingSafeEqual(presented, expected);
}

/** Read the body with a hard cap. Returns null when exceeded. */
export async function readBody(request: Request): Promise<string | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
	if (!request.body) return "";

	const reader = request.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(Buffer.from(value));
	}

	return Buffer.concat(chunks, total).toString("utf8");
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
		const { Render } = await import("@renderinc/sdk");
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

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

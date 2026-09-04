/**
 * The public API.
 *
 * The gateway runs no models, creates no infrastructure, and holds no
 * repository credential. It authenticates the caller, claims the run in
 * Postgres, and dispatches a prompt.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiKey } from "./config.js";
import { createAppRequestSchema } from "./contracts.js";
import { redactSecrets } from "./policy.js";
import { claimRun, finishRun, getRun, ping, type RunRecord } from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;
const RUN_ID = /^[0-9a-f-]{36}$/;
const TASK_NAME = "prompt-to-app";

export function createGateway(): Hono {
	const app = new Hono();

	app.get("/health", (c) => c.json({ status: "ok" }));

	app.get("/ready", async (c) => {
		try {
			await ping();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "unavailable" }, 503);
		}
	});

	app.post("/v1/apps", async (c) => {
		if (!authorized(c.req.raw.headers)) {
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
		const request = createAppRequestSchema.safeParse(parsed);
		if (!request.success) {
			return c.json(
				{
					error: "invalid request",
					detail:
						"prompt must be 8-2000 characters; user must be a lowercase slug",
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

		if (!(await dispatchWorkflow(TASK_NAME, { prompt, user, runId }))) {
			await finishRun(runId, "failed", { summary: "dispatch failed" }).catch(
				(error) => console.error("Failed to release run claim:", error),
			);
			return c.json({ error: "dispatch failed" }, 502);
		}

		return c.json(
			{ runId, user, status: "running", statusUrl: `/v1/apps/${runId}` },
			202,
		);
	});

	app.get("/v1/apps/:runId", async (c) => {
		if (!authorized(c.req.raw.headers)) {
			return c.json({ error: "unauthorized" }, 401);
		}

		const runId = c.req.param("runId");
		if (!RUN_ID.test(runId)) return c.json({ error: "not found" }, 404);

		let run: Awaited<ReturnType<typeof getRun>>;
		try {
			run = await getRun(runId);
		} catch (error) {
			console.error("Failed to read run:", error);
			return c.json({ error: "store unavailable" }, 503);
		}
		if (!run) return c.json({ error: "not found" }, 404);

		return c.json(runResponse(run));
	});

	return app;
}

export interface RunResponse {
	runId: string;
	status: string;
	stage: string | null;
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
	payload: { prompt: string; user: string; runId: string },
): Promise<boolean> {
	const slug = process.env.RENDER_WORKFLOW_SLUG;
	if (!slug) {
		console.error(`RENDER_WORKFLOW_SLUG not set — cannot dispatch ${taskName}`);
		return false;
	}

	try {
		const { Render } = await import("@renderinc/sdk");
		await new Render().workflows.startTask(`${slug}/${taskName}`, [payload]);
		return true;
	} catch (error) {
		console.error(`Failed to dispatch ${taskName}:`, error);
		return false;
	}
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

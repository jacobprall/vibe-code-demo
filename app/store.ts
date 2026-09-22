/** Postgres: one runs table. Render filesystems are ephemeral. */
import pg from "pg";
import { factoryConfig } from "../factory.config.js";

export type RunStatus =
	| "running"
	| "deployed"
	| "awaiting_blueprint"
	| "build_failed"
	| "deploy_failed"
	| "failed";

/** Coarse progress for GET /v1/apps/:runId. Cosmetic; never gates a run. */
export type RunStage =
	| "designing"
	| "provisioning"
	| "curating"
	| "building"
	| "verifying"
	| "publishing"
	| "deploying"
	| "waiting_for_services"
	| "waiting_for_deploys"
	| "smoke_testing"
	| "done";

export interface RunRecord {
	id: string;
	idempotencyKey: string;
	prompt: string;
	user: string;
	status: RunStatus;
	stage: RunStage | null;
	progress: string | null;
	workflowRunId: string | null;
	appName: string | null;
	webUrl: string | null;
	apiUrl: string | null;
	blueprintPath: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ClaimResult =
	| { claimed: true }
	| { claimed: false; reason: "duplicate"; runId: string }
	| { claimed: false; reason: "at_capacity" };

const COLUMNS = `id, idempotency_key, prompt, user_name, status, stage, progress,
	                workflow_run_id,
	                app_name, web_url, api_url, blueprint_path, summary,
	                created_at, updated_at`;

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error("DATABASE_URL is not set");
		pool = new pg.Pool({
			connectionString,
			max: 2,
			application_name: "vibe-factory",
			connectionTimeoutMillis: 5_000,
			idleTimeoutMillis: 10_000,
			allowExitOnIdle: true,
			options: "-c statement_timeout=15000 -c lock_timeout=5000",
		});
	}
	return pool;
}

export async function ping(): Promise<void> {
	await db().query("select 1");
}

/**
 * Claim a run. Postgres enforces both limits rather than application code:
 * the unique idempotency key stops a duplicate curl, and the conditional
 * insert stops the factory from running more sandboxes than it should.
 */
export async function claimRun(input: {
	id: string;
	idempotencyKey: string;
	prompt: string;
	user: string;
}): Promise<ClaimResult> {
	const inserted = await db().query(
		`insert into runs (id, idempotency_key, prompt, user_name)
		 select $1, $2, $3, $4
		 where (select count(*) from runs where status = 'running') < $5
		 on conflict (idempotency_key) do nothing`,
		[
			input.id,
			input.idempotencyKey,
			input.prompt,
			input.user,
			factoryConfig.maxConcurrentRuns,
		],
	);
	if (inserted.rowCount === 1) return { claimed: true };

	// Nothing inserted: either the key was seen before or we are at capacity.
	const { rows } = await db().query(
		"select id from runs where idempotency_key = $1",
		[input.idempotencyKey],
	);
	return rows.length > 0
		? { claimed: false, reason: "duplicate", runId: rows[0].id }
		: { claimed: false, reason: "at_capacity" };
}

export async function setRunStage(
	id: string,
	stage: RunStage,
	progress: string | null = null,
): Promise<void> {
	await db().query(
		"update runs set stage = $2, progress = $3, updated_at = now() where id = $1",
		[id, stage, progress],
	);
}

export async function touchRun(id: string, progress: string): Promise<void> {
	await db().query(
		"update runs set progress = $2, updated_at = now() where id = $1 and status = 'running'",
		[id, progress],
	);
}

export async function setWorkflowRunId(
	id: string,
	workflowRunId: string,
): Promise<void> {
	await db().query(
		"update runs set workflow_run_id = $2, updated_at = now() where id = $1",
		[id, workflowRunId],
	);
}

/** Throttle status reconciliation across gateway instances. */
export async function claimWorkflowCheck(id: string): Promise<boolean> {
	const result = await db().query(
		`update runs
		 set workflow_checked_at = now()
		 where id = $1
		   and status = 'running'
		   and (workflow_checked_at is null or workflow_checked_at < now() - interval '30 seconds')`,
		[id],
	);
	return result.rowCount === 1;
}

/** Repair rows misclassified when Workflows briefly reported `paused`. */
export async function reopenPausedRun(id: string): Promise<void> {
	await db().query(
		`update runs
		 set status = 'running', progress = 'Workflow paused; waiting to resume',
		     updated_at = now()
		 where id = $1 and status = 'failed'
		   and summary like 'Workflow paused:%'`,
		[id],
	);
}

export async function setRunApp(
	id: string,
	app: { appName: string; blueprintPath: string },
): Promise<void> {
	await db().query(
		`update runs set app_name = $2, blueprint_path = $3, updated_at = now()
		 where id = $1`,
		[id, app.appName, app.blueprintPath],
	);
}

export async function setRunUrls(
	id: string,
	urls: { webUrl: string | null; apiUrl: string | null },
): Promise<void> {
	await db().query(
		`update runs set web_url = $2, api_url = $3, updated_at = now()
		 where id = $1`,
		[id, urls.webUrl, urls.apiUrl],
	);
}

/** Moving off 'running' frees a concurrency slot. */
export async function finishRun(
	id: string,
	status: Exclude<RunStatus, "running">,
	details: { summary?: string } = {},
): Promise<void> {
	await db().query(
		`update runs
		 set status = $2,
		     stage = case when $2 in ('deployed', 'awaiting_blueprint') then 'done' else stage end,
		     progress = null,
		     summary = $3, updated_at = now()
		 where id = $1`,
		[id, status, details.summary ?? null],
	);
}

export async function getRun(id: string): Promise<RunRecord | null> {
	const { rows } = await db().query(
		`select ${COLUMNS} from runs where id = $1`,
		[id],
	);
	if (rows.length === 0) return null;
	return rowToRun(rows[0]);
}

export async function listRunsByUser(
	user: string,
	limit = 50,
): Promise<RunRecord[]> {
	const { rows } = await db().query(
		`select ${COLUMNS} from runs
		 where user_name = $1
		 order by created_at desc
		 limit $2`,
		[user, limit],
	);
	return rows.map(rowToRun);
}

function rowToRun(row: Record<string, unknown>): RunRecord {
	return {
		id: String(row.id),
		idempotencyKey: String(row.idempotency_key),
		prompt: String(row.prompt),
		user: String(row.user_name),
		status: row.status as RunStatus,
		stage: (row.stage as RunStage | null) ?? null,
		progress: (row.progress as string | null) ?? null,
		workflowRunId: (row.workflow_run_id as string | null) ?? null,
		appName: (row.app_name as string | null) ?? null,
		webUrl: (row.web_url as string | null) ?? null,
		apiUrl: (row.api_url as string | null) ?? null,
		blueprintPath: (row.blueprint_path as string | null) ?? null,
		summary: (row.summary as string | null) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
	};
}

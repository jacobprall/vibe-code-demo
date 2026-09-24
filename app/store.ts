/** Postgres: one runs table. Render filesystems are ephemeral. */
import pg from "pg";
import { factoryConfig } from "../factory.config.js";

export type RunStatus =
	| "running"
	| "deployed"
	| "awaiting_blueprint"
	| "build_failed"
	| "deploy_failed"
	| "failed"
	// While a delete of the run's app runs, and after it fails. A delete that
	// succeeds removes the row.
	| "deleting"
	| "delete_failed";

/** The statuses a prompt-to-app run ends in. */
export type FinishedStatus = Exclude<
	RunStatus,
	"running" | "deleting" | "delete_failed"
>;

/**
 * Coarse progress for GET /v1/apps/:runId, in pipeline order. Cosmetic;
 * never gates a run. The stage list in public/index.html must list these
 * stages in this order, each with a tooltip, and tests/gateway.test.ts checks
 * it. If the stage of a run is not in that list, the UI shows no progress for
 * the run.
 */
export const RUN_STAGES = [
	"designing",
	"provisioning",
	"curating",
	"building",
	"verifying",
	"publishing",
	"waiting_for_services",
	"waiting_for_deploys",
	"smoke_testing",
	"done",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

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

export type DeleteClaim =
	| { claimed: true; runIds: string[] }
	/** A delete of the app is already in progress. */
	| { claimed: false; reason: "deleting"; runIds: string[] }
	/** A running run would publish the app again. */
	| { claimed: false; reason: "running" }
	| { claimed: false; reason: "missing" };

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
 * Run statements in one transaction that holds the lock of one app. A delete
 * takes the lock to claim the runs of the app, and a run takes it to claim an
 * app name. So a run cannot start to build an app while it is being deleted.
 */
async function withAppLock<T>(
	user: string,
	appName: string,
	work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
	const client = await db().connect();
	try {
		await client.query("begin");
		// The lock must come before the reads: a statement sees only the rows
		// that were committed when it started.
		await client.query(
			"select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
			[user, appName],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
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
		   and status in ('running', 'deleting')
		   and (workflow_checked_at is null or workflow_checked_at < now() - interval '30 seconds')`,
		[id],
	);
	return result.rowCount === 1;
}

/**
 * Record the app that a run builds. Refused while a delete of the same app is
 * in progress, because the delete removes what this run publishes.
 */
export async function claimRunApp(
	id: string,
	user: string,
	app: { appName: string; blueprintPath: string },
): Promise<boolean> {
	return withAppLock(user, app.appName, async (client) => {
		const result = await client.query(
			`update runs set app_name = $3, blueprint_path = $4, updated_at = now()
			 where id = $1
			   and not exists (
			     select 1 from runs
			     where user_name = $2 and app_name = $3 and status = 'deleting'
			   )`,
			[id, user, app.appName, app.blueprintPath],
		);
		return result.rowCount === 1;
	});
}

/**
 * Mark every run of one app as deleting. The runs share the app's files and
 * resources, so they are deleted together. A second request while the delete
 * is in progress changes nothing.
 */
export async function claimDelete(
	user: string,
	appName: string,
): Promise<DeleteClaim> {
	return withAppLock(user, appName, async (client) => {
		const { rows } = await client.query<{ id: string; status: RunStatus }>(
			"select id, status from runs where user_name = $1 and app_name = $2",
			[user, appName],
		);
		if (rows.length === 0) return { claimed: false, reason: "missing" };
		if (rows.some((row) => row.status === "running")) {
			return { claimed: false, reason: "running" };
		}
		const runIds = rows.map((row) => row.id);
		if (rows.some((row) => row.status === "deleting")) {
			return { claimed: false, reason: "deleting", runIds };
		}

		await client.query(
			`update runs
			 set status = 'deleting', progress = 'Waiting for the delete to start',
			     workflow_run_id = null, updated_at = now()
			 where user_name = $1 and app_name = $2`,
			[user, appName],
		);
		return { claimed: true, runIds };
	});
}

/**
 * Delete a run that never chose an app. It created nothing but its row, so
 * no task is necessary. Returns false for a run that is still running.
 */
export async function deleteRunWithoutApp(id: string): Promise<boolean> {
	const result = await db().query(
		"delete from runs where id = $1 and app_name is null and status <> 'running'",
		[id],
	);
	return result.rowCount === 1;
}

/** Reconciliation reads this task run while the rows are deleting. */
export async function setDeleteWorkflowRunId(
	user: string,
	appName: string,
	workflowRunId: string,
): Promise<void> {
	await db().query(
		`update runs set workflow_run_id = $3, updated_at = now()
		 where user_name = $1 and app_name = $2 and status = 'deleting'`,
		[user, appName, workflowRunId],
	);
}

export async function setDeleteProgress(
	user: string,
	appName: string,
	progress: string,
): Promise<void> {
	await db().query(
		`update runs set progress = $3, updated_at = now()
		 where user_name = $1 and app_name = $2 and status = 'deleting'`,
		[user, appName, progress.slice(0, 500)],
	);
}

/**
 * The runs stay, so that the user can read why and delete them again. With a
 * task run ID, only the runs of that task change: a newer delete may own them.
 */
export async function failDelete(
	user: string,
	appName: string,
	summary: string,
	workflowRunId?: string,
): Promise<void> {
	await db().query(
		`update runs set status = 'delete_failed', progress = null, summary = $3,
		                 updated_at = now()
		 where user_name = $1 and app_name = $2 and status = 'deleting'
		   and ($4::text is null or workflow_run_id = $4)`,
		[user, appName, summary, workflowRunId ?? null],
	);
}

/** The last step of a delete: the app is gone, so its runs go too. */
export async function deleteRuns(user: string, appName: string): Promise<void> {
	await db().query(
		"delete from runs where user_name = $1 and app_name = $2 and status = 'deleting'",
		[user, appName],
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
	status: FinishedStatus,
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

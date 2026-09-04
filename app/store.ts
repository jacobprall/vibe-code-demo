/** Postgres: one runs table. Render filesystems are ephemeral. */
import pg from "pg";
import { airoConfig } from "../airo.config.js";

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
	| "curating"
	| "building"
	| "verifying"
	| "publishing"
	| "deploying"
	| "done";

export interface RunRecord {
	id: string;
	idempotencyKey: string;
	prompt: string;
	user: string;
	status: RunStatus;
	stage: RunStage | null;
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

const COLUMNS = `id, idempotency_key, prompt, user_name, status, stage,
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
			application_name: "airo-factory",
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
			airoConfig.maxConcurrentRuns,
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

export async function setRunStage(id: string, stage: RunStage): Promise<void> {
	await db().query(
		"update runs set stage = $2, updated_at = now() where id = $1",
		[id, stage],
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
		 set status = $2, stage = 'done', summary = $3, updated_at = now()
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

	const row = rows[0];
	return {
		id: row.id,
		idempotencyKey: row.idempotency_key,
		prompt: row.prompt,
		user: row.user_name,
		status: row.status,
		stage: row.stage,
		appName: row.app_name,
		webUrl: row.web_url,
		apiUrl: row.api_url,
		blueprintPath: row.blueprint_path,
		summary: row.summary,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

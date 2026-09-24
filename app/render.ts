/**
 * Everything the factory reads back from Render.
 *
 * Workflow code reads the Render REST API, which gives typed records. The
 * agents read Render through the hosted Render MCP server, on a read-only
 * allowlist; renderMcpUrl() names that server. Nothing in this file creates
 * or deletes a resource: creation is app/blueprint.ts plus a Git push, and
 * deletion is app/teardown.ts.
 */
import { requireEnv } from "./config.js";

const POLL_INTERVAL_MS = 5_000;
/** The attempts of one read before an error that stays fails it. */
const READ_ATTEMPTS = 5;
/** The API key is not valid, or it cannot read the resource. */
const AUTH_FAILURES = new Set([401, 403]);
const REST_API = "https://api.render.com/v1";
/** The largest page that the Render API sends. */
const PAGE_SIZE = 100;

const MAX_PAGE_SCRIPTS = 20;
const MODULE_PRELOAD = /\srel\s*=\s*["']?modulepreload\b/i;
const SCRIPT_REF = /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const DEPLOY_SUCCESS = new Set(["live"]);
const DEPLOY_FAILURE = new Set([
	"build_failed",
	"update_failed",
	"pre_deploy_failed",
	"canceled",
	"deactivated",
]);

/** The Render MCP server that the agents read Render through. */
export function renderMcpUrl(): string {
	return process.env.RENDER_MCP_URL?.trim() || "https://mcp.render.com/mcp";
}

/** A Render REST API request that got an error status. */
class RenderApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "RenderApiError";
	}
}

/* ── Services and deploys ─────────────────────────────────────────────── */

export interface ServiceRecord {
	id: string;
	name: string;
	url: string | null;
}

export interface DeployOutcome {
	deployId: string | null;
	status: string;
	/**
	 * `not_started`: no deploy after `after` started before the deadline, so
	 * `deployId` and `status` are those of the `after` deploy.
	 */
	result: "live" | "failed" | "timed_out" | "not_started";
}

/**
 * Wait for a Blueprint sync to produce the services we asked for. There is no
 * "sync finished" signal to subscribe to, so the services appearing by name is
 * the signal. A poll that fails is tried again, as retryRead() describes.
 */
export async function waitForServices(
	workspaceId: string,
	names: readonly string[],
	timeoutMs: number,
	onPoll?: (detail: string) => void | Promise<void>,
): Promise<Map<string, ServiceRecord>> {
	const deadline = Date.now() + timeoutMs;
	const wanted = new Set(names);
	let found = new Map<string, ServiceRecord>();

	while (Date.now() < deadline) {
		const services = await retryRead(
			"The service lookup",
			() => listServices(workspaceId, names),
			onPoll,
		);
		// Only an exact match counts, whatever the API's name filter matches.
		found = new Map(
			services
				.filter((service) => wanted.has(service.name))
				.map((service) => [service.name, service]),
		);
		if (found.size === wanted.size) return found;
		await onPoll?.(`Found ${found.size}/${wanted.size} services`);
		await sleep(POLL_INTERVAL_MS);
	}
	return found;
}

/** One page. An app has far fewer services than a page holds. */
async function listServices(
	workspaceId: string,
	names: readonly string[],
): Promise<ServiceRecord[]> {
	const query = new URLSearchParams({
		ownerId: workspaceId,
		limit: String(PAGE_SIZE),
	});
	for (const name of names) query.append("name", name);
	const page = await readApi<
		{
			service?: {
				id: string;
				name: string;
				serviceDetails?: { url?: string };
			};
		}[]
	>(`/services?${query}`, "Listing services");
	return page.flatMap(({ service }) =>
		service
			? [
					{
						id: service.id,
						name: service.name,
						// A smoke check adds a path to this URL.
						url: service.serviceDetails?.url?.replace(/\/$/, "") ?? null,
					},
				]
			: [],
	);
}

/**
 * Poll until the newest deploy of a service is in a terminal state.
 *
 * A push does not start a deploy immediately. Render gets the GitHub webhook,
 * syncs the Blueprint, and then creates the deploy. Until then, the newest
 * deploy is the deploy from before the push. Give its ID as `after`, and the
 * poll continues until a newer deploy is terminal. If no newer deploy starts
 * before the deadline, the result is `not_started`: the push did not deploy
 * the service. A poll that fails is tried again, as retryRead() describes.
 */
export async function waitForDeploy(
	serviceId: string,
	opts: {
		timeoutMs: number;
		/** The deploy from before the push. Only a newer deploy is a result. */
		after?: string | null;
		onPoll?: (detail: string) => void | Promise<void>;
	},
): Promise<DeployOutcome> {
	const deadline = Date.now() + opts.timeoutMs;
	let status = "unknown";
	let deployId: string | null = null;
	let stale = false;

	while (Date.now() < deadline) {
		const latest = await retryRead(
			`The deploy lookup of ${serviceId}`,
			() => latestDeploy(serviceId),
			opts.onPoll,
		);
		if (latest) {
			deployId = latest.id;
			status = latest.status;
			stale = deployId === opts.after;
		}
		if (!stale && DEPLOY_SUCCESS.has(status)) {
			return { deployId, status, result: "live" };
		}
		if (!stale && DEPLOY_FAILURE.has(status)) {
			return { deployId, status, result: "failed" };
		}
		await opts.onPoll?.(
			stale
				? `Service ${serviceId}: waiting for a deploy after ${deployId}`
				: `Service ${serviceId}: ${status}`,
		);
		await sleep(POLL_INTERVAL_MS);
	}

	if (stale) return { deployId, status, result: "not_started" };
	return { deployId, status: `timed out while ${status}`, result: "timed_out" };
}

/** The newest deploy of a service, or null when it has none. */
async function latestDeploy(
	serviceId: string,
): Promise<{ id: string; status: string } | null> {
	const page = await readApi<{ deploy?: { id: string; status?: string } }[]>(
		`/services/${encodeURIComponent(serviceId)}/deploys?limit=1`,
		`Listing the deploys of ${serviceId}`,
	);
	const deploy = page[0]?.deploy;
	return deploy ? { id: deploy.id, status: deploy.status ?? "unknown" } : null;
}

export interface HttpProbe {
	ok: boolean;
	status: number;
	body: string;
	/** Empty unless the request succeeded. Carries the CORS headers. */
	headers: Headers;
}

/**
 * The final check: the public URL actually serves. `headers` lets a caller
 * send an Origin and inspect what came back, which is the only way to see a
 * CORS failure — a server-side fetch is happy without the header a browser
 * requires.
 */
export async function waitForHttpOk(
	url: string,
	timeoutMs: number,
	opts: {
		headers?: Record<string, string>;
		onPoll?: (detail: string) => void | Promise<void>;
	} = {},
): Promise<HttpProbe> {
	const deadline = Date.now() + timeoutMs;
	let status = 0;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				redirect: "follow",
				headers: opts.headers,
				signal: AbortSignal.timeout(15_000),
			});
			status = response.status;
			if (response.ok) {
				return {
					ok: true,
					status,
					body: (await response.text()).slice(0, 20_000),
					headers: response.headers,
				};
			}
		} catch {
			// CDN propagation and cold starts both lag the deploy going live.
		}
		await opts.onPoll?.(`Waiting for ${url} (last status ${status || "none"})`);
		await sleep(POLL_INTERVAL_MS);
	}

	return { ok: false, status, body: "", headers: new Headers() };
}

/**
 * Whether a deployed page contains `text` in its HTML or in a script that it
 * loads. A static site gets its env vars at build time, so its bundle is the
 * only place that shows the values that a browser uses.
 */
export async function pageContains(
	pageUrl: string,
	text: string,
): Promise<boolean> {
	const html = await readText(pageUrl);
	if (html === null) return false;
	if (html.includes(text)) return true;
	const scripts = await Promise.all(pageScripts(html, pageUrl).map(readText));
	return scripts.some((script) => script?.includes(text));
}

/**
 * The scripts that a page loads from its own origin: each `<script src>`, and
 * each `<link rel="modulepreload">` that Vite adds for a split chunk. A chunk
 * that only a dynamic import loads is not in the HTML, so this cannot find it.
 *
 * Scripts from other origins are not included. An agent wrote the page, and
 * the page must not send the workflow to other hosts.
 */
export function pageScripts(html: string, pageUrl: string): string[] {
	const origin = new URL(pageUrl).origin;
	const scripts = new Set<string>();
	const markup = html.replace(/<!--[\s\S]*?-->/g, "");
	for (const [tag, element] of markup.matchAll(/<(script|link)\b[^>]*>/gi)) {
		if (element.toLowerCase() === "link" && !MODULE_PRELOAD.test(tag)) continue;
		const match = SCRIPT_REF.exec(tag);
		const ref = match?.[1] ?? match?.[2] ?? match?.[3];
		if (!ref) continue;
		const url = URL.parse(ref, pageUrl);
		if (url?.origin === origin) scripts.add(url.href);
	}
	return [...scripts].slice(0, MAX_PAGE_SCRIPTS);
}

/** The full body of a successful GET, or null. */
async function readText(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		return response.ok ? await response.text() : null;
	} catch {
		return null;
	}
}

/* ── REST API ─────────────────────────────────────────────────────────── */

/** One call to the Render REST API. */
export function renderApi(
	path: string,
	method: "GET" | "DELETE" = "GET",
): Promise<Response> {
	return fetch(`${REST_API}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${requireEnv("RENDER_API_KEY")}`,
			accept: "application/json",
		},
		signal: AbortSignal.timeout(30_000),
	});
}

/**
 * One read of the Render REST API. An error status is a RenderApiError, so
 * that retryRead() can tell an authentication failure from a temporary one.
 */
async function readApi<T>(path: string, what: string): Promise<T> {
	const response = await renderApi(path);
	if (!response.ok) {
		const hint = AUTH_FAILURES.has(response.status)
			? " The API key needs read access to the workspace."
			: "";
		throw new RenderApiError(
			`${what} failed with ${response.status}.${hint}`,
			response.status,
		);
	}
	return (await response.json()) as T;
}

/* ── Blueprints ───────────────────────────────────────────────────────── */

export interface BlueprintRecord {
	id: string;
	name: string;
	status: string;
	autoSync: boolean;
	repo: string;
	branch: string;
	path: string;
}

export interface BlueprintSync {
	/** The commit that the sync applies, if Render reports it. */
	commit: string | null;
	/** `created`, `pending`, `running`, `success`, or `error`. */
	state: string;
}

/**
 * The Blueprint in a workspace that watches a repository, branch, and file —
 * if one exists.
 *
 * An API key can read all the workspaces of its user, and the API sends the
 * list in pages. Read only the factory workspace: waitForServices looks for
 * services only there. Then read each page, because the first page can stop
 * before the Blueprint.
 *
 * Null means that no Blueprint matches. If the lookup cannot finish, it
 * throws: a failed request is not proof that no Blueprint exists. A failed
 * page request is tried again, as retryRead() describes.
 */
export async function findBlueprint(target: {
	workspaceId: string;
	repo: string;
	branch: string;
	path: string;
}): Promise<BlueprintRecord | null> {
	const wanted = normalizeRepo(target.repo);
	let cursor: string | undefined;
	do {
		const query = new URLSearchParams({
			ownerId: target.workspaceId,
			limit: String(PAGE_SIZE),
		});
		if (cursor) query.set("cursor", cursor);
		const page = await retryRead("The Blueprint lookup", () =>
			readApi<{ blueprint?: BlueprintRecord; cursor?: string }[]>(
				`/blueprints?${query}`,
				"Listing Blueprints",
			),
		);
		const match = page
			.map((entry) => entry.blueprint)
			.find(
				(blueprint): blueprint is BlueprintRecord =>
					!!blueprint &&
					normalizeRepo(blueprint.repo) === wanted &&
					blueprint.branch === target.branch &&
					blueprint.path === target.path,
			);
		if (match) return match;
		// A short page is the last page.
		cursor = page.length === PAGE_SIZE ? page.at(-1)?.cursor : undefined;
	} while (cursor);
	return null;
}

/**
 * The newest syncs of a Blueprint, newest first. A push that only removes
 * resources from the Blueprint file starts no sync.
 */
export async function listBlueprintSyncs(id: string): Promise<BlueprintSync[]> {
	const page = await readApi<unknown>(
		`/blueprints/${encodeURIComponent(id)}/syncs?limit=20`,
		`Listing the syncs of Blueprint ${id}`,
	);
	// Without the list, a running sync would look like no sync. Stop instead.
	if (!Array.isArray(page)) {
		throw new Error(`Blueprint ${id} returned no list of syncs.`);
	}
	return page.map(
		(entry: { sync?: { commit?: { id?: string }; state?: string } }) => ({
			commit: entry.sync?.commit?.id ?? null,
			state: entry.sync?.state ?? "unknown",
		}),
	);
}

function normalizeRepo(repo: string): string {
	return repo
		.toLowerCase()
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}

/* ── Failed reads ─────────────────────────────────────────────────────── */

/**
 * Do one read of Render state, and do it again if it fails. A run or a delete
 * reads Render for many minutes after its push, and most failures are
 * temporary: a network error, a timeout, a 429, or a 5xx. Without this, one
 * failed poll ends the run or the delete.
 *
 * An authentication failure is thrown at once, because a new attempt cannot
 * repair the API key. A different error is thrown when READ_ATTEMPTS
 * attempts in sequence fail. Thus a wait does not hide a permanent error
 * until its deadline. `onRetry` gets each failure before the next attempt.
 */
export async function retryRead<T>(
	what: string,
	read: () => Promise<T>,
	onRetry?: (detail: string) => void | Promise<void>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await read();
		} catch (error) {
			if (isAuthFailure(error)) throw error;
			const reason = errorText(error);
			if (attempt === READ_ATTEMPTS) {
				throw new Error(
					`${what} failed ${READ_ATTEMPTS} times in sequence. The last error: ${reason}`,
					{ cause: error },
				);
			}
			console.warn(
				JSON.stringify({ event: "render_read_failed", what, attempt, reason }),
			);
			await onRetry?.(
				`${what} failed (attempt ${attempt} of ${READ_ATTEMPTS}): ${reason}`,
			);
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

function isAuthFailure(error: unknown): boolean {
	return error instanceof RenderApiError && AUTH_FAILURES.has(error.status);
}

function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	// fetch() gives "fetch failed" for each network error. The cause tells why.
	const cause = error.cause instanceof Error ? error.cause.message : "";
	return cause ? `${error.message}: ${cause}` : error.message;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

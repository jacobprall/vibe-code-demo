/**
 * Everything the factory reads back from Render.
 *
 * Reads go over the hosted Render MCP server — the same server the architect
 * agent talks to, on a read-only allowlist. The one exception is Blueprints,
 * which MCP does not expose; those come from the REST API. Nothing in this
 * file creates a service: that is app/blueprint.ts plus a Git push.
 */
import { requireEnv } from "./config.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_LOG_CHARS = 8_000;
const REST_API = "https://api.render.com/v1";

const SERVICE_ID = /^srv-[A-Za-z0-9]+$/;
const DEPLOY_ID = /^dep-[A-Za-z0-9]+$/;
const RENDER_URL = /^https:\/\/[A-Za-z0-9-]+\.onrender\.com\/?$/;

const DEPLOY_SUCCESS = new Set(["live"]);
const DEPLOY_FAILURE = new Set([
	"build_failed",
	"update_failed",
	"pre_deploy_failed",
	"canceled",
	"deactivated",
]);

export function renderMcpUrl(): string {
	return process.env.RENDER_MCP_URL?.trim() || "https://mcp.render.com/mcp";
}

export class McpError extends Error {
	constructor(
		message: string,
		readonly tool?: string,
	) {
		super(message);
		this.name = "McpError";
	}
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
}

/* ── MCP transport ────────────────────────────────────────────────────── */

export class RenderMcp {
	private sessionId?: string;
	private nextId = 1;
	private ready?: Promise<void>;

	constructor(
		private readonly url: string,
		private readonly token: string,
	) {}

	static fromEnv(): RenderMcp {
		return new RenderMcp(renderMcpUrl(), requireEnv("RENDER_API_KEY"));
	}

	/** Call a tool and return its payload, parsed as JSON where possible. */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		opts: { timeoutMs?: number } = {},
	): Promise<unknown> {
		await this.initialize();
		const result = await this.rpc(
			"tools/call",
			{ name, arguments: args },
			opts.timeoutMs,
		);
		return toolPayload(name, result);
	}

	private initialize(): Promise<void> {
		this.ready ??= this.handshake();
		return this.ready;
	}

	private async handshake(): Promise<void> {
		await this.rpc("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "airo-factory", version: "0.1.0" },
		});
		// Required by the spec before any other request is served.
		await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	private async rpc(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<unknown> {
		const id = this.nextId++;
		const messages = await this.send(
			{ jsonrpc: "2.0", id, method, params },
			timeoutMs,
		);
		if (!messages) throw new McpError(`${method} returned no body`);

		const message = messages.find((candidate) => candidate.id === id);
		if (!message) throw new McpError(`No MCP response for request ${id}`);
		if (message.error) {
			throw new McpError(`${method} failed: ${message.error.message}`);
		}
		return message.result;
	}

	private async send(
		body: Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<JsonRpcResponse[] | null> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			// Streamable HTTP servers may answer with either.
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${this.token}`,
			"mcp-protocol-version": PROTOCOL_VERSION,
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

		const response = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});

		const session = response.headers.get("mcp-session-id");
		if (session) this.sessionId = session;

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new McpError(
				`Render MCP responded ${response.status}: ${detail.slice(0, 300)}`,
			);
		}
		// Notifications are answered with 202 and no body.
		if (response.status === 202) return null;

		const text = await response.text();
		if (!text.trim()) return null;
		return (response.headers.get("content-type") ?? "").includes(
			"text/event-stream",
		)
			? parseSse(text)
			: [JSON.parse(text) as JsonRpcResponse];
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
	live: boolean;
}

export async function listServices(
	mcp: RenderMcp,
	workspaceId: string,
): Promise<ServiceRecord[]> {
	return serviceRecords(await mcp.callTool("list_services", { workspaceId }));
}

/**
 * Wait for a Blueprint sync to produce the services we asked for. There is no
 * "sync finished" signal to subscribe to, so the services appearing by name is
 * the signal.
 */
export async function waitForServices(
	mcp: RenderMcp,
	workspaceId: string,
	names: readonly string[],
	timeoutMs: number,
): Promise<Map<string, ServiceRecord>> {
	const deadline = Date.now() + timeoutMs;
	const wanted = new Set(names);
	let found = new Map<string, ServiceRecord>();

	while (Date.now() < deadline) {
		found = new Map(
			(await listServices(mcp, workspaceId))
				.filter((service) => wanted.has(service.name))
				.map((service) => [service.name, service]),
		);
		if (found.size === wanted.size) return found;
		await sleep(POLL_INTERVAL_MS);
	}
	return found;
}

/** Poll until a service's newest deploy reaches a terminal state. */
export async function waitForDeploy(
	mcp: RenderMcp,
	serviceId: string,
	opts: { workspaceId: string; timeoutMs: number },
): Promise<DeployOutcome> {
	const deadline = Date.now() + opts.timeoutMs;
	let status = "unknown";
	let deployId: string | null = null;

	while (Date.now() < deadline) {
		const [latest] = findDeploys(
			await mcp.callTool("list_deploys", {
				serviceId,
				limit: 1,
				workspaceId: opts.workspaceId,
			}),
		);
		if (latest) {
			deployId = latest.id;
			status = latest.status;
			if (DEPLOY_SUCCESS.has(status)) return { deployId, status, live: true };
			if (DEPLOY_FAILURE.has(status)) return { deployId, status, live: false };
		}
		await sleep(POLL_INTERVAL_MS);
	}

	return { deployId, status: `timed out while ${status}`, live: false };
}

/**
 * Ask for a new deploy. Blueprint services deploy on commit, so this is only
 * needed to redeploy without a code change.
 */
export async function triggerDeploy(
	mcp: RenderMcp,
	serviceId: string,
	workspaceId: string,
): Promise<void> {
	await mcp.callTool("trigger_deploy", { serviceId, workspaceId });
}

/** Build logs for a failing deploy, for the builder agent to read. */
export async function fetchBuildLogs(
	mcp: RenderMcp,
	serviceId: string,
	workspaceId: string,
): Promise<string> {
	try {
		const payload = await mcp.callTool("list_logs", {
			resource: [serviceId],
			type: ["build"],
			limit: 100,
			direction: "backward",
			workspaceId,
		});
		return findLogMessages(payload).join("\n").slice(-MAX_LOG_CHARS);
	} catch (error) {
		// Logs are diagnostic. Losing them must not turn a reportable failure
		// into a thrown run.
		console.error("Failed to fetch build logs:", error);
		return "";
	}
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
	opts: { headers?: Record<string, string> } = {},
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
		await sleep(POLL_INTERVAL_MS);
	}

	return { ok: false, status, body: "", headers: new Headers() };
}

/* ── Blueprints (REST; not exposed over MCP) ──────────────────────────── */

export interface BlueprintRecord {
	id: string;
	name: string;
	status: string;
	autoSync: boolean;
	repo: string;
	branch: string;
	path: string;
}

/** The Blueprint watching a repository, branch, and file — if one exists. */
export async function findBlueprint(target: {
	repo: string;
	branch: string;
	path: string;
}): Promise<BlueprintRecord | null> {
	const response = await fetch(`${REST_API}/blueprints?limit=100`, {
		headers: {
			authorization: `Bearer ${requireEnv("RENDER_API_KEY")}`,
			accept: "application/json",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`Listing Blueprints failed with ${response.status}. The API key needs read access to the workspace.`,
		);
	}

	const body = (await response.json()) as { blueprint?: BlueprintRecord }[];
	const wanted = normalizeRepo(target.repo);
	return (
		body
			.map((entry) => entry.blueprint)
			.find(
				(blueprint): blueprint is BlueprintRecord =>
					!!blueprint &&
					normalizeRepo(blueprint.repo) === wanted &&
					blueprint.branch === target.branch &&
					blueprint.path === target.path,
			) ?? null
	);
}

function normalizeRepo(repo: string): string {
	return repo
		.toLowerCase()
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}

/* ── Payload extraction ───────────────────────────────────────────────── */

export interface DeployRecord {
	id: string;
	status: string;
}

/**
 * MCP tool results are shaped by the server, not by a contract we own, and
 * Render wraps created resources differently from listed ones. Rather than
 * guess at one envelope, walk the payload for the fields we need.
 */
export function serviceRecords(payload: unknown): ServiceRecord[] {
	const services: ServiceRecord[] = [];
	walk(payload, (node) => {
		if (
			typeof node.id === "string" &&
			SERVICE_ID.test(node.id) &&
			typeof node.name === "string"
		) {
			services.push({
				id: node.id,
				name: node.name,
				url: findServiceUrl(node),
			});
		}
	});
	return services;
}

export function findServiceUrl(payload: unknown): string | null {
	const url = findString(payload, (value) => RENDER_URL.test(value));
	return url ? url.replace(/\/$/, "") : null;
}

/** Deploys, most recent first, as Render's list endpoint returns them. */
export function findDeploys(payload: unknown): DeployRecord[] {
	const deploys: DeployRecord[] = [];
	walk(payload, (node) => {
		if (
			typeof node.id === "string" &&
			DEPLOY_ID.test(node.id) &&
			typeof node.status === "string"
		) {
			deploys.push({ id: node.id, status: node.status });
		}
	});
	return deploys;
}

/** Log lines, oldest first, from a list_logs payload. */
export function findLogMessages(payload: unknown): string[] {
	const lines: string[] = [];
	walk(payload, (node) => {
		const message = node.message ?? node.text;
		if (typeof message === "string" && message.length > 0) lines.push(message);
	});
	return lines.reverse();
}

function findString(
	payload: unknown,
	matches: (value: string) => boolean,
): string | null {
	let found: string | null = null;
	walk(payload, (node) => {
		if (found) return;
		for (const value of Object.values(node)) {
			if (typeof value === "string" && matches(value)) {
				found = value;
				return;
			}
		}
	});
	return found;
}

function walk(
	payload: unknown,
	visit: (node: Record<string, unknown>) => void,
): void {
	if (Array.isArray(payload)) {
		for (const item of payload) walk(item, visit);
		return;
	}
	if (typeof payload !== "object" || payload === null) return;

	const node = payload as Record<string, unknown>;
	visit(node);
	for (const value of Object.values(node)) {
		if (typeof value === "object" && value !== null) walk(value, visit);
	}
}

/** Pull JSON-RPC messages out of an SSE stream. */
function parseSse(text: string): JsonRpcResponse[] {
	const messages: JsonRpcResponse[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice("data:".length).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			messages.push(JSON.parse(payload) as JsonRpcResponse);
		} catch {
			// A keep-alive or comment frame; nothing to do.
		}
	}
	return messages;
}

/**
 * Tool results carry text blocks and, on newer servers, structured content.
 * Prefer the structured form; otherwise parse the text as JSON and fall back
 * to the raw string so callers can still log something useful.
 */
function toolPayload(tool: string, result: unknown): unknown {
	if (typeof result !== "object" || result === null) return result;
	const record = result as Record<string, unknown>;

	if (record.isError === true) {
		throw new McpError(
			`${tool}: ${textOf(record) || "tool reported an error"}`,
			tool,
		);
	}
	if (record.structuredContent !== undefined) return record.structuredContent;

	const text = textOf(record);
	if (!text) return null;
	return parseToolText(text) ?? text;
}

/**
 * Parse the JSON value a tool's text block leads with, or null.
 *
 * Paginated tools append their cursor after the JSON — `list_deploys` returns
 * `[{...}]\n\n cursor: <opaque>` — so a strict parse fails and every caller
 * silently sees a string instead of records. That cost a run a fifteen-minute
 * deploy timeout on a deploy that went live in thirteen seconds. Nothing here
 * paginates, so the cursor is dropped rather than returned.
 */
export function parseToolText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the leading JSON value.
	}

	const start = text.search(/[[{]/);
	if (start === -1) return null;

	const end = text.lastIndexOf(text[start] === "[" ? "]" : "}");
	if (end <= start) return null;

	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function textOf(result: Record<string, unknown>): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter(
			(block): block is { text: string } =>
				typeof block === "object" &&
				block !== null &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

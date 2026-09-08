/** The Agent type and runClaude() over the Claude Agent SDK. */
import {
	createSdkMcpServer,
	query,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { factoryConfig, type ModelTier } from "../factory.config.js";
import { requireEnv } from "./config.js";
import { checkToolCall, RENDER_MCP_SERVER } from "./policy.js";
import { renderMcpUrl } from "./render.js";
import type { Sandbox } from "./sandbox.js";
import type { Tool, ToolResult } from "./tools.js";

const MCP_SERVER = "factory";

/** Only these env vars are forwarded to the Claude subprocess. */
const ENV_ALLOWLIST = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"HOME",
	"LANG",
	"LC_ALL",
	"NO_PROXY",
	"PATH",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"TMPDIR",
	"USER",
] as const;

export interface Agent {
	/** Also the registered Render task name. Must be unique and stable. */
	readonly id: string;
	readonly description?: string;
	readonly model: ModelTier;
	readonly prompt: string;
	readonly tools?: readonly Tool[];
	/**
	 * Read-only Render MCP tools this agent may call, from
	 * RENDER_READ_ONLY_TOOLS. Lets an agent inspect the workspace it designs
	 * for; it can never create or change anything.
	 */
	readonly renderTools?: readonly string[];
	readonly maxTurns?: number;
	/** Render Workflows instance plan. */
	readonly plan?: string;
}

export interface ClaudeRun {
	result: string;
	structuredOutput?: unknown;
	inputTokens: number;
	outputTokens: number;
}

export interface RunClaudeOptions {
	agentId: string;
	systemPrompt: string;
	prompt: string;
	model: string;
	maxTurns?: number;
	tools?: readonly Tool[];
	renderTools?: readonly string[];
	sandbox?: Sandbox;
	/** Directory relative paths resolve against. Defaults to the checkout. */
	workDir?: string;
	signal?: AbortSignal;
	/** When set, the SDK enforces structured JSON output matching this schema. */
	outputSchema?: Record<string, unknown>;
}

export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeRun> {
	const tools = opts.tools ?? [];
	if (tools.length > 0 && !opts.sandbox) {
		throw new Error(
			`Agent "${opts.agentId}" declares tools but was given no sandbox`,
		);
	}

	const renderTools = opts.renderTools ?? [];
	const allowed = [
		...tools.map((tool) => `mcp__${MCP_SERVER}__${tool.name}`),
		...renderTools.map((name) => `mcp__${RENDER_MCP_SERVER}__${name}`),
	];

	const options: Options = {
		systemPrompt: opts.systemPrompt,
		model: opts.model,
		maxTurns: opts.maxTurns,
		// Claude's built-in Bash/Read/Write/Edit stay off — agents reach the
		// machine only through our sandbox tools.
		tools: [],
		allowedTools: allowed.length > 0 ? allowed : undefined,
		permissionMode: "dontAsk",
		env: Object.fromEntries(
			ENV_ALLOWLIST.map((name) => [name, process.env[name]]),
		),
		hooks: { PreToolUse: [{ hooks: [enforcePolicy] }] },
	};

	if (opts.outputSchema) {
		options.outputFormat = {
			type: "json_schema",
			schema: opts.outputSchema,
		};
	}

	const servers: NonNullable<Options["mcpServers"]> = {};

	if (renderTools.length > 0) {
		servers[RENDER_MCP_SERVER] = {
			type: "http",
			url: renderMcpUrl(),
			headers: { Authorization: `Bearer ${requireEnv("RENDER_API_KEY")}` },
			alwaysLoad: true,
		};
	}

	const sandbox = opts.sandbox;
	const workDir = opts.workDir ?? factoryConfig.repoDir;
	if (sandbox && tools.length > 0) {
		servers[MCP_SERVER] = createSdkMcpServer({
			name: MCP_SERVER,
			alwaysLoad: true,
			tools: tools.map((tool) =>
				sdkTool(tool.name, tool.description, tool.inputSchema, async (args) =>
					toContentBlocks(
						await tool.invoke(args, {
							sandbox,
							workDir,
							signal: opts.signal,
						}),
					),
				),
			),
		});
	}

	if (Object.keys(servers).length > 0) options.mcpServers = servers;
	if (opts.signal) options.abortController = abortControllerFor(opts.signal);

	for await (const message of query({ prompt: opts.prompt, options })) {
		if (message.type !== "result") continue;
		if (message.subtype !== "success" || message.is_error) {
			throw new Error(
				`Agent "${opts.agentId}" failed: ${failureReason(message)}`,
			);
		}
		const raw = message as unknown as Record<string, unknown>;
		return {
			result: message.result,
			structuredOutput: raw.structured_output,
			...usageTotals(message),
		};
	}

	throw new Error(`Agent "${opts.agentId}" produced no result`);
}

/** Tagged template that strips leading indentation from inline prompts. */
export function md(
	strings: TemplateStringsArray,
	...values: unknown[]
): string {
	const lines = String.raw(strings, ...values).split("\n");
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	const indents = lines
		.filter((line) => line.trim().length > 0)
		.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0);
	const indent = indents.length > 0 ? Math.min(...indents) : 0;

	return indent > 0
		? lines.map((line) => line.slice(indent)).join("\n")
		: lines.join("\n");
}

export type AgentCall = (message: string) => string | Promise<string>;

/**
 * Call an agent that must return structured JSON. Uses the SDK's native
 * structured output via outputFormat when available, with parseModelJson
 * as a fallback for text-mode agents.
 */
export async function agentJson<T>(
	call: AgentCall,
	schema: z.ZodType<T>,
	message: string,
	stage: string,
): Promise<T> {
	const raw = await call(message);

	// The agent may have returned structured_output via the SDK, in which
	// case the raw string is JSON that parses directly.
	const direct = tryParse(schema, raw);
	if (direct) return direct;

	// Fallback: extract JSON from prose/fences.
	const extracted = parseModelJson(schema, raw);
	if (extracted) return extracted;

	// One repair attempt.
	console.warn(JSON.stringify({ event: "model_json_repair", stage }));
	const raw2 = await call(
		`${message}\n\nYour previous response was not valid JSON matching the required schema. Return ONLY the JSON object, no prose.`,
	);
	const repaired = tryParse(schema, raw2) ?? parseModelJson(schema, raw2);
	if (repaired) return repaired;

	throw new Error(`${stage} returned invalid structured output twice`);
}

function tryParse<T>(schema: z.ZodType<T>, raw: string): T | null {
	try {
		return schema.parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Parse JSON from model output. Models wrap JSON in prose, code fences, or
 * both — try every reasonable extraction before giving up.
 */
export function parseModelJson<T>(schema: z.ZodType<T>, raw: string): T | null {
	for (const candidate of jsonCandidates(raw)) {
		try {
			return schema.parse(JSON.parse(candidate));
		} catch {
			// Try next candidate.
		}
	}
	return null;
}

function* jsonCandidates(raw: string): Generator<string> {
	// Fenced code blocks (largest first).
	const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
	for (const match of fences.sort((a, b) => b[1].length - a[1].length)) {
		yield match[1].trim();
	}
	// First { to last }.
	const first = raw.indexOf("{");
	const last = raw.lastIndexOf("}");
	if (first !== -1 && last > first) {
		yield raw.slice(first, last + 1);
	}
}

/**
 * Convert a Zod schema to a JSON Schema object the SDK's outputFormat accepts.
 * Strips the $schema draft declaration that the Claude CLI rejects.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
	delete jsonSchema.$schema;
	return jsonSchema;
}

/* ── Internals ────────────────────────────────────────────────────────── */

function bareToolName(name: string): string {
	const prefix = `mcp__${MCP_SERVER}__`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const enforcePolicy = async (input: {
	hook_event_name: string;
	tool_name?: string;
	tool_input?: unknown;
}) => {
	if (input.hook_event_name !== "PreToolUse") return {};
	const reason = checkToolCall(
		bareToolName(input.tool_name ?? ""),
		isRecord(input.tool_input) ? input.tool_input : {},
	);
	return {
		hookSpecificOutput: reason
			? {
					hookEventName: "PreToolUse" as const,
					permissionDecision: "deny" as const,
					permissionDecisionReason: reason,
				}
			: {
					hookEventName: "PreToolUse" as const,
					permissionDecision: "allow" as const,
				},
	};
};

function toContentBlocks(result: ToolResult) {
	return {
		content: [{ type: "text" as const, text: result.content }],
		isError: result.isError ?? false,
	};
}

function abortControllerFor(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) {
		controller.abort(signal.reason);
	} else {
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}
	return controller;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(
	source: Record<string, unknown>,
	...keys: string[]
): number {
	for (const key of keys) {
		if (typeof source[key] === "number") return source[key];
	}
	return 0;
}

function usageTotals(message: SDKMessage): {
	inputTokens: number;
	outputTokens: number;
} {
	const raw = message as unknown as Record<string, unknown>;
	let inputTokens = 0;
	let outputTokens = 0;

	if (isRecord(raw.modelUsage)) {
		for (const entry of Object.values(raw.modelUsage)) {
			if (!isRecord(entry)) continue;
			inputTokens += tokenCount(entry, "inputTokens", "input_tokens");
			outputTokens += tokenCount(entry, "outputTokens", "output_tokens");
		}
	}
	if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };

	const usage = isRecord(raw.usage) ? raw.usage : undefined;
	if (!usage) return { inputTokens: 0, outputTokens: 0 };
	return {
		inputTokens: tokenCount(usage, "inputTokens", "input_tokens"),
		outputTokens: tokenCount(usage, "outputTokens", "output_tokens"),
	};
}

function failureReason(message: SDKMessage): string {
	const raw = message as unknown as Record<string, unknown>;
	if (Array.isArray(raw.errors) && raw.errors.length > 0) {
		return raw.errors.join("; ");
	}
	if (typeof raw.result === "string") return raw.result;
	return String(raw.stop_reason ?? raw.subtype ?? "unknown error");
}

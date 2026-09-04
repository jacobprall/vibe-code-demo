/** The Agent type and runClaude() over the Claude Agent SDK. */
import {
	createSdkMcpServer,
	query,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import type { ModelTier } from "../airo.config.js";
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
	signal?: AbortSignal;
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

	const servers: NonNullable<Options["mcpServers"]> = {};

	if (renderTools.length > 0) {
		// The hosted Render MCP server. The key travels in the server config
		// rather than the subprocess environment, and allowedTools plus
		// checkToolCall keep this connection read-only.
		servers[RENDER_MCP_SERVER] = {
			type: "http",
			url: renderMcpUrl(),
			headers: { Authorization: `Bearer ${requireEnv("RENDER_API_KEY")}` },
			alwaysLoad: true,
		};
	}

	const sandbox = opts.sandbox;
	if (sandbox && tools.length > 0) {
		servers[MCP_SERVER] = createSdkMcpServer({
			name: MCP_SERVER,
			alwaysLoad: true,
			tools: tools.map((tool) =>
				sdkTool(
					tool.name,
					tool.description,
					tool.inputSchema,
					async (args) =>
						toContentBlocks(
							await tool.invoke(args, { sandbox, signal: opts.signal }),
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
		return { result: message.result, ...usageTotals(message) };
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

/** Parse JSON from model output. Tolerates code fences and leading prose. */
export function parseModelJson<T>(schema: z.ZodType<T>, raw: string): T | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	const candidate =
		fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
	try {
		return schema.parse(JSON.parse(candidate));
	} catch {
		return null;
	}
}

export type AgentCall = (message: string) => string | Promise<string>;

/** Call an agent that must return JSON. One repair attempt, then fail closed. */
export async function agentJson<T>(
	call: AgentCall,
	schema: z.ZodType<T>,
	message: string,
	stage: string,
): Promise<T> {
	const parsed = parseModelJson(schema, await call(message));
	if (parsed) return parsed;

	console.warn(JSON.stringify({ event: "model_json_repair", stage }));
	const repaired = parseModelJson(
		schema,
		await call(
			`${message}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
		),
	);
	if (repaired) return repaired;

	throw new Error(`${stage} returned invalid structured output twice`);
}

/**
 * Strip our own MCP prefix so policy rules match the bare sandbox tool name.
 * Render MCP names keep their prefix — that is how checkToolCall recognizes
 * them and holds them to the read-only allowlist.
 */
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

/** Extract total token usage from a result message across SDK versions. */
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

/** The Agent type and runClaude() over the Claude Agent SDK. */
import {
	createSdkMcpServer,
	query,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelUsage, Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ModelTier } from "../factory.config.js";
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
	readonly model: ModelTier;
	readonly prompt: string;
	/** Adaptive-thinking depth. Lower effort reduces latency for stage demos. */
	readonly effort?: Options["effort"];
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
	effort?: Options["effort"];
	maxTurns?: number;
	tools?: readonly Tool[];
	renderTools?: readonly string[];
	sandbox?: Sandbox;
	/**
	 * The app directory. Relative paths resolve against it, and a tool path
	 * must land in it or in /tmp. Required with tools.
	 */
	workDir?: string;
	/** When set, the SDK enforces structured JSON output matching this schema. */
	outputSchema?: Record<string, unknown>;
}

export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeRun> {
	const tools = opts.tools ?? [];
	const { sandbox, workDir } = opts;
	if (tools.length > 0 && (!sandbox || !workDir)) {
		throw new Error(
			`Agent "${opts.agentId}" declares tools but was given no sandbox or no app directory`,
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
		effort: opts.effort,
		maxTurns: opts.maxTurns,
		// Claude's built-in Bash/Read/Write/Edit stay off — agents reach the
		// machine only through our sandbox tools.
		tools: [],
		allowedTools: allowed.length > 0 ? allowed : undefined,
		permissionMode: "dontAsk",
		env: Object.fromEntries(
			ENV_ALLOWLIST.map((name) => [name, process.env[name]]),
		),
		hooks: { PreToolUse: [{ hooks: [policyHook(workDir)] }] },
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

	if (sandbox && workDir && tools.length > 0) {
		servers[MCP_SERVER] = createSdkMcpServer({
			name: MCP_SERVER,
			alwaysLoad: true,
			tools: tools.map((tool) =>
				sdkTool(tool.name, tool.description, tool.inputSchema, async (args) =>
					toContentBlocks(await tool.invoke(args, { sandbox, workDir })),
				),
			),
		});
	}

	if (Object.keys(servers).length > 0) options.mcpServers = servers;

	for await (const message of query({ prompt: opts.prompt, options })) {
		if (message.type !== "result") continue;
		if (message.subtype !== "success") {
			throw new Error(
				`Agent "${opts.agentId}" failed: ${message.errors.join("; ") || message.subtype}`,
			);
		}
		if (message.is_error) {
			throw new Error(`Agent "${opts.agentId}" failed: ${message.result}`);
		}
		return {
			result: message.result,
			structuredOutput: message.structured_output,
			...usageTotals(message.modelUsage),
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

/**
 * Call an agent that must return structured output, and check the output
 * with its Zod schema. The SDK checks it against the JSON Schema of the
 * agent, but a JSON Schema cannot hold each Zod rule, such as a refinement.
 * So a failure goes back to the agent one time, with the Zod error, and a
 * second failure stops the stage.
 */
export async function agentJson<T>(
	call: (message: string) => Promise<unknown>,
	schema: z.ZodType<T>,
	message: string,
	stage: string,
): Promise<T> {
	const first = schema.safeParse(await call(message));
	if (first.success) return first.data;

	const problem = z.prettifyError(first.error);
	console.warn(JSON.stringify({ event: "model_json_repair", stage, problem }));
	const second = schema.safeParse(
		await call(
			`${message}\n\nYour previous response did not match the required schema:\n${problem}\nReturn a response that matches it.`,
		),
	);
	if (second.success) return second.data;

	throw new Error(
		`${stage} returned invalid structured output twice: ${z.prettifyError(second.error)}`,
	);
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

/** The PreToolUse hook. Tool paths must land in `workDir` or in /tmp. */
function policyHook(workDir: string | undefined) {
	return async (input: {
		hook_event_name: string;
		tool_name?: string;
		tool_input?: unknown;
	}) => {
		if (input.hook_event_name !== "PreToolUse") return {};
		const reason = checkToolCall(
			bareToolName(input.tool_name ?? ""),
			isRecord(input.tool_input) ? input.tool_input : {},
			workDir,
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
}

function toContentBlocks(result: ToolResult) {
	return {
		content: [{ type: "text" as const, text: result.content }],
		isError: result.isError ?? false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Each model of the run, the subagents and compaction included. */
function usageTotals(modelUsage: Record<string, ModelUsage>): {
	inputTokens: number;
	outputTokens: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	for (const usage of Object.values(modelUsage)) {
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;
	}
	return { inputTokens, outputTokens };
}

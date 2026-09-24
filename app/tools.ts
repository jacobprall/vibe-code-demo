/** The tools an agent can be granted, and the Tool contract itself. */
import { z } from "zod";
import { resolveSandboxPath } from "./policy.js";
import { type Sandbox, shellEscape } from "./sandbox.js";

export const MAX_OUTPUT_CHARS = 50_000;
export const MAX_READ_CHARS = 100_000;

export type ZodShape = Record<string, z.ZodType>;

/** Infer the argument type from a raw Zod shape (e.g. `{ path: z.string() }`). */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

export interface ToolContext {
	/** Bound by workflow code. A tool can never choose its own sandbox. */
	readonly sandbox: Sandbox;
	/**
	 * Also bound by workflow code: the app directory. Every relative path an
	 * agent gives is resolved against it, and every path must land in it or in
	 * /tmp. The exec API starts in `/`, so without this a relative path lands
	 * outside the app.
	 */
	readonly workDir: string;
}

export interface ToolResult {
	readonly content: string;
	readonly isError?: boolean;
}

export interface Tool<Schema extends ZodShape = ZodShape> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Schema;
	invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}

export function truncate(value: string, limit = MAX_OUTPUT_CHARS): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n... (truncated, ${value.length - limit} chars omitted)`;
}

/** A rejected path, as the tool result the model sees. */
function pathError(error: string): ToolResult {
	return { content: error, isError: true };
}

/* ── Files ────────────────────────────────────────────────────────────── */

const readFileSchema = {
	path: z
		.string()
		.describe(
			"File path. Relative paths are resolved against the app directory.",
		),
};

export const sandboxReadFile: Tool<typeof readFileSchema> = {
	name: "sandbox__read_file",
	description: "Read a UTF-8 file from the sandbox. Returns its contents.",
	inputSchema: readFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const target = resolveSandboxPath(ctx.workDir, input.path);
		if ("error" in target) return pathError(target.error);

		const content = await ctx.sandbox.readFile(target.path);
		return { content: truncate(content, MAX_READ_CHARS) };
	},
};

const writeFileSchema = {
	path: z
		.string()
		.describe(
			"File path. Relative paths are resolved against the app directory.",
		),
	content: z.string().describe("Full file contents to write."),
};

export const sandboxWriteFile: Tool<typeof writeFileSchema> = {
	name: "sandbox__write_file",
	description:
		"Create or overwrite a UTF-8 file in the sandbox. Parent directories are created automatically.",
	inputSchema: writeFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const target = resolveSandboxPath(ctx.workDir, input.path);
		if ("error" in target) return pathError(target.error);

		await ctx.sandbox.writeFile(target.path, input.content);
		return {
			content: `Wrote ${Buffer.byteLength(input.content, "utf-8")} bytes to ${target.path}`,
		};
	},
};

const listDirSchema = {
	path: z
		.string()
		.optional()
		.describe("Directory path. Defaults to the app directory."),
};

export const sandboxListDir: Tool<typeof listDirSchema> = {
	name: "sandbox__list_dir",
	description:
		"List entries in a directory. Directories are suffixed with '/'. Defaults to the app directory.",
	inputSchema: listDirSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const target = resolveSandboxPath(ctx.workDir, input.path || ".");
		if ("error" in target) return pathError(target.error);

		const entries = await ctx.sandbox.listDir(target.path);
		return { content: entries.join("\n") || "(empty directory)" };
	},
};

/* ── Search and execution ─────────────────────────────────────────────── */

const searchSchema = {
	pattern: z.string().describe("Regex pattern to search for."),
	path: z
		.string()
		.optional()
		.describe("Directory or file to search. Defaults to the app directory."),
	include: z
		.string()
		.optional()
		.describe("Glob to filter files (e.g. '*.ts'). Optional."),
};

export const sandboxSearch: Tool<typeof searchSchema> = {
	name: "sandbox__search",
	description:
		"Search file contents using ripgrep. Returns matching lines with file paths and line numbers.",
	inputSchema: searchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const target = resolveSandboxPath(ctx.workDir, input.path || ".");
		if ("error" in target) return pathError(target.error);

		const args = ["rg", "--line-number", "--no-heading"];
		if (input.include) args.push("--glob", input.include);
		args.push("--", input.pattern, target.path);

		const { output, exitCode } = await ctx.sandbox.run(
			args.map(shellEscape).join(" "),
		);
		// ripgrep exits 1 when there are simply no matches.
		if (exitCode === 1) return { content: "(no matches)" };
		if (exitCode > 1) {
			return {
				content: `Search failed (exit ${exitCode}):\n${truncate(output)}`,
				isError: true,
			};
		}
		return { content: truncate(output) };
	},
};

const execSchema = {
	command: z.string().describe("The shell command to execute."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory. Defaults to the app directory."),
};

export const sandboxExec: Tool<typeof execSchema> = {
	name: "sandbox__exec",
	description:
		"Execute a shell command in the sandbox, from the app directory unless cwd says otherwise. " +
		"Returns combined stdout/stderr and the exit code. " +
		"A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
	inputSchema: execSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		// Always cd first. The exec API starts in `/`, so a command built from
		// relative paths would otherwise write outside the checkout.
		const cwd = resolveSandboxPath(ctx.workDir, input.cwd ?? ".");
		if ("error" in cwd) return pathError(cwd.error);

		const command = `cd ${shellEscape(cwd.path)} && ${input.command}`;
		const { output, exitCode } = await ctx.sandbox.run(command);
		const body = truncate(output) || "(no output)";
		return {
			content: exitCode === 0 ? body : `Exit code: ${exitCode}\n${body}`,
			isError: exitCode !== 0,
		};
	},
};

const applyPatchSchema = {
	diff: z.string().describe("A unified diff in `git apply` format."),
	cwd: z
		.string()
		.optional()
		.describe(
			"Working directory for the patch. Defaults to the app directory.",
		),
};

let patchCounter = 0;

export const sandboxApplyPatch: Tool<typeof applyPatchSchema> = {
	name: "sandbox__apply_patch",
	description:
		"Apply a unified diff (git apply format) to files in the sandbox. Prefer this for multi-file edits.",
	inputSchema: applyPatchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const cwd = resolveSandboxPath(ctx.workDir, input.cwd ?? ".");
		if ("error" in cwd) return pathError(cwd.error);

		const patchPath = `/tmp/.vibe-${Date.now()}-${++patchCounter}.patch`;
		await ctx.sandbox.upload(patchPath, input.diff);

		const { output, exitCode } = await ctx.sandbox.run(
			`cd ${shellEscape(cwd.path)} && git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
		);
		if (exitCode !== 0) {
			return {
				content: `Patch failed (exit ${exitCode}):\n${truncate(output)}`,
				isError: true,
			};
		}
		return { content: "Patch applied successfully." };
	},
};

/** The tools of the builder, the one agent that works in the sandbox. */
export const sandboxTools: readonly Tool[] = [
	sandboxReadFile,
	sandboxListDir,
	sandboxSearch,
	sandboxExec,
	sandboxWriteFile,
	sandboxApplyPatch,
];

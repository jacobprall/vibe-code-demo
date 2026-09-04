/** The tools an agent can be granted, and the Tool contract itself. */
import { z } from "zod";
import { airoConfig } from "../airo.config.js";
import { type Sandbox, shellEscape } from "./sandbox.js";

export const MAX_OUTPUT_CHARS = 50_000;
export const MAX_READ_CHARS = 100_000;

export type ZodShape = Record<string, z.ZodType>;

/** Infer the argument type from a raw Zod shape (e.g. `{ path: z.string() }`). */
export type InferShape<T extends ZodShape> = z.output<z.ZodObject<T>>;

export interface ToolContext {
	/** Bound by workflow code. A tool can never choose its own sandbox. */
	readonly sandbox: Sandbox;
	readonly signal?: AbortSignal;
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

/* ── Files ────────────────────────────────────────────────────────────── */

const readFileSchema = {
	path: z.string().describe("File path within the sandbox."),
};

export const sandboxReadFile: Tool<typeof readFileSchema> = {
	name: "sandbox__read_file",
	description: "Read a UTF-8 file from the sandbox. Returns its contents.",
	inputSchema: readFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const content = await ctx.sandbox.readFile(input.path);
		return { content: truncate(content, MAX_READ_CHARS) };
	},
};

const writeFileSchema = {
	path: z.string().describe("File path within the sandbox."),
	content: z.string().describe("Full file contents to write."),
};

export const sandboxWriteFile: Tool<typeof writeFileSchema> = {
	name: "sandbox__write_file",
	description:
		"Create or overwrite a UTF-8 file in the sandbox. Parent directories are created automatically.",
	inputSchema: writeFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		await ctx.sandbox.writeFile(input.path, input.content);
		return {
			content: `Wrote ${Buffer.byteLength(input.content, "utf-8")} bytes to ${input.path}`,
		};
	},
};

const listDirSchema = {
	path: z.string().optional().describe("Directory path. Defaults to '.'."),
};

export const sandboxListDir: Tool<typeof listDirSchema> = {
	name: "sandbox__list_dir",
	description:
		"List entries in a directory. Directories are suffixed with '/'. Defaults to the sandbox root.",
	inputSchema: listDirSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const entries = await ctx.sandbox.listDir(input.path || ".");
		return { content: entries.join("\n") || "(empty directory)" };
	},
};

/* ── Search and execution ─────────────────────────────────────────────── */

const searchSchema = {
	pattern: z.string().describe("Regex pattern to search for."),
	path: z
		.string()
		.optional()
		.describe("Directory or file to search. Defaults to '.'."),
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
		const args = ["rg", "--line-number", "--no-heading"];
		if (input.include) args.push("--glob", input.include);
		args.push("--", input.pattern, input.path || ".");

		const { output, exitCode } = await ctx.sandbox.run(
			args.map(shellEscape).join(" "),
			{ signal: ctx.signal },
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
	cwd: z.string().optional().describe("Working directory. Optional."),
};

export const sandboxExec: Tool<typeof execSchema> = {
	name: "sandbox__exec",
	description:
		"Execute a shell command in the sandbox. Returns combined stdout/stderr and the exit code. " +
		"A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
	inputSchema: execSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const command = input.cwd
			? `cd ${shellEscape(input.cwd)} && ${input.command}`
			: input.command;
		const { output, exitCode } = await ctx.sandbox.run(command, {
			signal: ctx.signal,
		});
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
		.describe("Working directory for the patch. Optional."),
};

let patchCounter = 0;

export const sandboxApplyPatch: Tool<typeof applyPatchSchema> = {
	name: "sandbox__apply_patch",
	description:
		"Apply a unified diff (git apply format) to files in the sandbox. Prefer this for multi-file edits.",
	inputSchema: applyPatchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const patchPath = `/tmp/.airo-${Date.now()}-${++patchCounter}.patch`;
		await ctx.sandbox.upload(patchPath, input.diff);

		const cd = input.cwd ? `cd ${shellEscape(input.cwd)} && ` : "";
		const { output, exitCode } = await ctx.sandbox.run(
			`${cd}git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
			{ signal: ctx.signal },
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

/* ── Placeholder imagery ──────────────────────────────────────────────── */

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;

const assetSearchSchema = {
	query: z.string().describe("What to find photographs of."),
	limit: z.number().int().min(1).max(10).optional().describe("Default 6."),
};

/**
 * Wikimedia Commons is the whole of the factory's reachable internet: it needs
 * no API key and everything it returns is openly licensed, which is what makes
 * shipping the result to a customer demo defensible.
 */
export const assetSearch: Tool<typeof assetSearchSchema> = {
	name: "asset__search",
	description:
		"Search Wikimedia Commons for openly licensed photographs. Returns candidate " +
		"image URLs with dimensions and the credit line each one must be published with.",
	inputSchema: assetSearchSchema,
	async invoke(input): Promise<ToolResult> {
		const params = new URLSearchParams({
			action: "query",
			format: "json",
			formatversion: "2",
			generator: "search",
			gsrsearch: `filetype:bitmap ${input.query}`,
			gsrnamespace: "6",
			gsrlimit: String(input.limit ?? 6),
			prop: "imageinfo",
			iiprop: "url|size|extmetadata",
			iiurlwidth: "1400",
		});

		const response = await fetch(`${COMMONS_API}?${params}`, {
			headers: { "user-agent": "airo-factory/0.1 (Render demo)" },
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return {
				content: `Commons search failed with ${response.status}`,
				isError: true,
			};
		}

		const candidates = parseCommons(await response.json());
		return candidates.length > 0
			? { content: JSON.stringify(candidates, null, 2) }
			: { content: `No openly licensed images found for "${input.query}".` };
	},
};

const assetFetchSchema = {
	url: z.string().describe("An image URL returned by asset__search."),
	path: z
		.string()
		.describe("Absolute destination path inside the app's public directory."),
};

/**
 * A download may only land in a storefront's public asset directory, and only
 * under an image name. Without this, a tool whose whole job is writing bytes
 * from the internet could overwrite a Blueprint or another user's app.
 */
const ASSET_DESTINATION = /\/web\/public\/assets\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/;

export const assetFetch: Tool<typeof assetFetchSchema> = {
	name: "asset__fetch",
	description:
		"Download an image found by asset__search into the app. Only URLs on the " +
		"factory's allowed hosts are reachable, and only images are accepted.",
	inputSchema: assetFetchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		if (!ASSET_DESTINATION.test(input.path)) {
			return {
				content:
					"Destination must be an image file under a storefront's " +
					"web/public/assets directory.",
				isError: true,
			};
		}

		let url: URL;
		try {
			url = new URL(input.url);
		} catch {
			return { content: `Not a URL: ${input.url}`, isError: true };
		}
		// The allowlist is enforced here, in workflow-owned code, rather than
		// anywhere a model can influence.
		if (url.protocol !== "https:") {
			return { content: "Only https URLs are allowed.", isError: true };
		}
		if (!airoConfig.assets.allowedHosts.includes(url.hostname)) {
			return {
				content: `Host not allowed: ${url.hostname}. Allowed: ${airoConfig.assets.allowedHosts.join(", ")}`,
				isError: true,
			};
		}

		const response = await fetch(url, {
			headers: { "user-agent": "airo-factory/0.1 (Render demo)" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			return {
				content: `Download failed with ${response.status}`,
				isError: true,
			};
		}
		if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
			return { content: "That URL is not an image.", isError: true };
		}

		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > airoConfig.assets.maxBytes) {
			return {
				content: `Image is ${bytes.byteLength} bytes, over the ${airoConfig.assets.maxBytes} byte limit.`,
				isError: true,
			};
		}

		await ctx.sandbox.writeFile(input.path, bytes);
		return { content: `Saved ${bytes.byteLength} bytes to ${input.path}` };
	},
};

interface CommonsCandidate {
	title: string;
	url: string;
	width: number;
	height: number;
	credit: string;
}

function parseCommons(payload: unknown): CommonsCandidate[] {
	const pages = (payload as { query?: { pages?: unknown[] } }).query?.pages;
	if (!Array.isArray(pages)) return [];

	const candidates: CommonsCandidate[] = [];
	for (const page of pages) {
		const record = page as {
			title?: string;
			imageinfo?: {
				thumburl?: string;
				url?: string;
				thumbwidth?: number;
				thumbheight?: number;
				extmetadata?: Record<string, { value?: string }>;
			}[];
		};
		const info = record.imageinfo?.[0];
		const url = info?.thumburl ?? info?.url;
		if (!url || !record.title) continue;

		const meta = info?.extmetadata ?? {};
		const artist = stripHtml(meta.Artist?.value ?? "Wikimedia Commons");
		const license = stripHtml(meta.LicenseShortName?.value ?? "see Commons");
		candidates.push({
			title: record.title,
			url,
			width: info?.thumbwidth ?? 0,
			height: info?.thumbheight ?? 0,
			credit: `${artist} / Wikimedia Commons (${license})`,
		});
	}
	return candidates;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

/* ── Tool sets ────────────────────────────────────────────────────────── */

export const readTools: readonly Tool[] = [
	sandboxReadFile,
	sandboxListDir,
	sandboxSearch,
];

export const writeTools: readonly Tool[] = [
	sandboxExec,
	sandboxWriteFile,
	sandboxApplyPatch,
];

export const assetTools: readonly Tool[] = [assetSearch, assetFetch];

export const allTools: readonly Tool[] = [...readTools, ...writeTools];

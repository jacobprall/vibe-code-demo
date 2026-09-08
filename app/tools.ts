/** The tools an agent can be granted, and the Tool contract itself. */
import { z } from "zod";
import { factoryConfig } from "../factory.config.js";
import { type ResolvedPath, resolveSandboxPath } from "./policy.js";
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
	 * Also bound by workflow code: the directory every relative path an agent
	 * gives is resolved against. The exec API starts in `/`, so without this a
	 * relative path lands outside the checkout.
	 */
	readonly workDir: string;
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
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
		let candidates: CommonsCandidate[];
		try {
			candidates = await searchCommonsRelaxed(input.query, input.limit ?? 6);
		} catch (error) {
			return {
				content: `Commons search failed: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
		return candidates.length > 0
			? { content: JSON.stringify(candidates, null, 2) }
			: { content: `No openly licensed images found for "${input.query}".` };
	},
};

const assetFetchSchema = {
	url: z.string().describe("An image URL returned by asset__search."),
	path: z
		.string()
		.describe(
			"Destination path inside the app's assets directory. Relative paths " +
				"are resolved against the app directory.",
		),
};

/**
 * A download may only land in an `assets/` directory inside the checkout, and
 * only under an image name. Without this, a tool whose whole job is writing
 * bytes from the internet could overwrite a Blueprint or another user's app.
 *
 * The builder chooses its own layout, so this cannot pin a framework's
 * convention — it pins the two things that matter: inside the repo, and under
 * a directory named `assets`.
 */
const ASSET_DESTINATION =
	/\/assets\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/;

/** Resolves against workDir first, so `assets/chair.jpg` lands in the app. */
function assetDestination(workDir: string, path: string): ResolvedPath {
	const target = resolveSandboxPath(workDir, path);
	if ("error" in target) {
		return {
			error: `Destination must be inside the checkout. ${target.error}`,
		};
	}
	if (!target.path.startsWith(`${factoryConfig.repoDir}/`)) {
		return {
			error: `Destination must be inside the checkout (${factoryConfig.repoDir}).`,
		};
	}
	if (!ASSET_DESTINATION.test(target.path)) {
		return {
			error:
				"Destination must be a .jpg/.png/.webp file inside an assets/ directory.",
		};
	}
	return target;
}

export const assetFetch: Tool<typeof assetFetchSchema> = {
	name: "asset__fetch",
	description:
		"Download an image found by asset__search into the app. Only URLs on the " +
		"factory's allowed hosts are reachable, and only images are accepted.",
	inputSchema: assetFetchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const destination = assetDestination(ctx.workDir, input.path);
		if ("error" in destination) return pathError(destination.error);

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
		if (!factoryConfig.assets.allowedHosts.includes(url.hostname)) {
			return {
				content: `Host not allowed: ${url.hostname}. Allowed: ${factoryConfig.assets.allowedHosts.join(", ")}`,
				isError: true,
			};
		}

		const response = await fetch(url, {
			headers: { "user-agent": "vibe-factory/0.1 (Render demo)" },
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
		if (bytes.byteLength > factoryConfig.assets.maxBytes) {
			return {
				content: `Image is ${bytes.byteLength} bytes, over the ${factoryConfig.assets.maxBytes} byte limit.`,
				isError: true,
			};
		}

		await ctx.sandbox.writeFile(destination.path, bytes);
		return {
			content: `Saved ${bytes.byteLength} bytes to ${destination.path}`,
		};
	},
};

/* ── Batch collection ─────────────────────────────────────────────────── */

const assetCollectSchema = {
	subjects: z
		.array(z.string().min(3).max(120))
		.min(1)
		.max(8)
		.describe("Every subject to photograph, all at once."),
	destDir: z
		.string()
		.describe(
			"The assets directory to download into. Must end in /assets. Relative " +
				"paths are resolved against the app directory.",
		),
};

/**
 * Search and download every subject in one call.
 *
 * The curator used to do this one subject at a time, which cost two model
 * round trips per image. Selection is a heuristic here — the largest candidate
 * above a usable size — because "which of these six photos looks right" is not
 * worth a round trip for placeholder imagery. The agent still owns naming and
 * alt text, which is where its judgment actually shows.
 */
export const assetCollect: Tool<typeof assetCollectSchema> = {
	name: "asset__collect",
	description:
		"Search Wikimedia Commons for every subject and download the best match for each, " +
		"all in one call. Returns what landed, with the credit line each image must be " +
		"published with. Prefer this over calling asset__search and asset__fetch per subject.",
	inputSchema: assetCollectSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const resolved = resolveSandboxPath(
			ctx.workDir,
			input.destDir.replace(/\/+$/, ""),
		);
		if ("error" in resolved) {
			return pathError(
				`destDir must be inside the checkout. ${resolved.error}`,
			);
		}
		const destDir = resolved.path;
		if (!destDir.startsWith(`${factoryConfig.repoDir}/`)) {
			return pathError(
				`destDir must be inside the checkout (${factoryConfig.repoDir}).`,
			);
		}
		if (!destDir.endsWith("/assets")) {
			return pathError("destDir must end in /assets.");
		}

		const budget = Math.min(input.subjects.length, factoryConfig.assets.maxCount);
		const subjects = input.subjects.slice(0, budget);

		// Every subject in parallel — this is the whole point of the tool.
		const results = await Promise.all(
			subjects.map((subject) => collectOne(subject, destDir, ctx)),
		);

		const collected = results.filter((r) => r.path);
		const skipped = results.filter((r) => !r.path);

		if (collected.length === 0) {
			return {
				content: `No usable images found. ${skipped.map((s) => `${s.subject}: ${s.reason}`).join("; ")}`,
				isError: true,
			};
		}

		return {
			content: JSON.stringify(
				{
					collected: collected.map((r) => ({
						subject: r.subject,
						path: r.path,
						credit: r.credit,
						width: r.width,
						height: r.height,
					})),
					skipped: skipped.map((r) => ({
						subject: r.subject,
						reason: r.reason,
					})),
				},
				null,
				2,
			),
		};
	},
};

interface CollectResult {
	subject: string;
	path?: string;
	credit?: string;
	width?: number;
	height?: number;
	reason?: string;
}

/**
 * Minimum width of the file behind the thumbnail. Measuring the thumbnail
 * instead is useless — Commons renders every one to the requested box, so a
 * 450px original comes back the same width as a 4000px one, upscaled.
 */
const MIN_SOURCE_WIDTH = 600;

/**
 * Pick one candidate: a real photograph, wide rather than tall, best source
 * available.
 *
 * Sorting by thumbnail area used to win, and since every thumbnail is capped
 * to the same width, that meant "tallest" — which selected portraits, the
 * largest files, and the worst shapes for a hero image.
 */
export function bestCandidate(
	candidates: readonly CommonsCandidate[],
): CommonsCandidate | undefined {
	const realEnough = candidates.filter(
		(candidate) => candidate.sourceWidth >= MIN_SOURCE_WIDTH,
	);
	const pool = realEnough.length > 0 ? realEnough : candidates;
	const landscape = pool.filter(
		(candidate) => candidate.sourceWidth >= candidate.sourceHeight,
	);

	return [...(landscape.length > 0 ? landscape : pool)].sort(
		(a, b) => b.sourceWidth * b.sourceHeight - a.sourceWidth * a.sourceHeight,
	)[0];
}

async function collectOne(
	subject: string,
	destDir: string,
	ctx: ToolContext,
): Promise<CollectResult> {
	let candidates: CommonsCandidate[];
	try {
		candidates = await searchCommonsRelaxed(subject, 8);
	} catch (error) {
		return {
			subject,
			reason: `search failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const pick = bestCandidate(candidates);
	if (!pick) return { subject, reason: "no results" };

	const path = `${destDir}/${slugify(subject)}${extensionOf(pick.url)}`;
	try {
		const bytes = await downloadImage(pick.url);
		await ctx.sandbox.writeFile(path, bytes);
		return {
			subject,
			path,
			credit: pick.credit,
			width: pick.width,
			height: pick.height,
		};
	} catch (error) {
		return {
			subject,
			reason: `download failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Fetch and validate one image, or throw with a reportable reason. */
async function downloadImage(rawUrl: string): Promise<Buffer> {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") throw new Error("not https");
	if (!factoryConfig.assets.allowedHosts.includes(url.hostname)) {
		throw new Error(`host not allowed: ${url.hostname}`);
	}

	const response = await fetch(url, {
		headers: { "user-agent": "vibe-factory/0.1 (Render demo)" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
		throw new Error("not an image");
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength > factoryConfig.assets.maxBytes) {
		throw new Error(`${bytes.byteLength} bytes exceeds the limit`);
	}
	return bytes;
}

function slugify(subject: string): string {
	return (
		subject
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "image"
	);
}

function extensionOf(url: string): string {
	const match = url.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
	return match ? `.${match[1].toLowerCase()}` : ".jpg";
}

/* ── Commons ──────────────────────────────────────────────────────────── */

/**
 * Words that carry no weight in an image search but do count as terms Commons
 * requires a match for.
 */
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"at",
	"closeup",
	"for",
	"from",
	"full",
	"image",
	"in",
	"into",
	"near",
	"of",
	"on",
	"over",
	"photo",
	"photograph",
	"the",
	"to",
	"under",
	"with",
]);

/**
 * Progressively shorter forms of one subject, longest first.
 *
 * Commons ANDs every term, so a natural-language subject like "Beneteau
 * Oceanis sailboat sailing offshore" matches nothing while "Beneteau Oceanis
 * sailboat" matches plenty. The architect writes prose; this turns it into
 * something the search can answer instead of leaving the model to guess.
 */
export function commonsQueries(subject: string): string[] {
	const words = subject.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
	const significant = words.filter((word) => !STOPWORDS.has(word));

	const ladder = [
		subject.trim(),
		significant.join(" "),
		significant.slice(0, 4).join(" "),
		significant.slice(0, 3).join(" "),
		significant.slice(0, 2).join(" "),
	];
	return [...new Set(ladder.filter((query) => query.length > 0))];
}

/**
 * Search Commons for a subject, relaxing the query until something comes back.
 * Attempts are sequential: Commons rate-limits, and the first one usually wins.
 */
async function searchCommonsRelaxed(
	subject: string,
	limit: number,
): Promise<CommonsCandidate[]> {
	let candidates: CommonsCandidate[] = [];
	for (const query of commonsQueries(subject)) {
		candidates = await searchCommons(query, limit);
		if (candidates.length > 0) return candidates;
	}
	return candidates;
}

/** Query Commons and return parsed candidates. Shared by both asset tools. */
async function searchCommons(
	query: string,
	limit: number,
): Promise<CommonsCandidate[]> {
	const params = new URLSearchParams({
		action: "query",
		format: "json",
		formatversion: "2",
		generator: "search",
		gsrsearch: `filetype:bitmap ${query}`,
		gsrnamespace: "6",
		gsrlimit: String(limit),
		prop: "imageinfo",
		iiprop: "url|size|extmetadata",
		// Width only. Passing iiurlheight as well moves the thumbnails to
		// thumb.wikimedia.org, which is not an allowed host — bestCandidate
		// keeps the tall originals out instead.
		iiurlwidth: String(factoryConfig.assets.imageWidth),
	});

	// Relaxing a query multiplies the requests a run makes, and every subject
	// searches in parallel, so back off once rather than losing the subject.
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${COMMONS_API}?${params}`, {
			headers: { "user-agent": "vibe-factory/0.1 (Render demo)" },
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
		if (response.ok) return parseCommons(await response.json());
		if (response.status !== 429 || attempt === RATE_LIMIT_RETRIES) {
			throw new Error(`Commons responded ${response.status}`);
		}
		await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
	}
}

export interface CommonsCandidate {
	title: string;
	url: string;
	/** Dimensions of the thumbnail that will land on disk. */
	width: number;
	height: number;
	/** Dimensions of the file behind it, which is what quality depends on. */
	sourceWidth: number;
	sourceHeight: number;
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
				thumbwidth?: number;
				thumbheight?: number;
				width?: number;
				height?: number;
				extmetadata?: Record<string, { value?: string }>;
			}[];
		};
		const info = record.imageinfo?.[0];
		// Thumbnail only. Falling back to the original once shipped an archive
		// master into a landing page.
		if (!info?.thumburl || !record.title) continue;

		const meta = info.extmetadata ?? {};
		const artist = stripHtml(meta.Artist?.value ?? "Wikimedia Commons");
		const license = stripHtml(meta.LicenseShortName?.value ?? "see Commons");
		candidates.push({
			title: record.title,
			url: info.thumburl,
			width: info.thumbwidth ?? 0,
			height: info.thumbheight ?? 0,
			sourceWidth: info.width ?? 0,
			sourceHeight: info.height ?? 0,
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

/**
 * asset__collect first — it is the one the curator should reach for. The
 * per-subject pair stays available for the case the batch tool skipped
 * something and the agent wants to retry it by hand.
 */
export const assetTools: readonly Tool[] = [
	assetCollect,
	assetSearch,
	assetFetch,
];

export const allTools: readonly Tool[] = [...readTools, ...writeTools];

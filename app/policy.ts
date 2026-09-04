/** The one gate between a model and the machine. */
import { airoConfig } from "../airo.config.js";

export const PATH_TOOLS = new Set([
	"sandbox__read_file",
	"sandbox__write_file",
	"sandbox__list_dir",
	"asset__fetch",
	"asset__collect",
]);

/** Tools whose `cwd` is a path; their `command` and `diff` are not. */
export const CWD_TOOLS = new Set(["sandbox__exec", "sandbox__apply_patch"]);

/** Scratch space an agent may use for things that are not part of the app. */
const SCRATCH_DIR = "/tmp";

/**
 * Render MCP tools an agent may call. The architect needs to see what already
 * exists in the workspace to reason about primitives; it has no business
 * changing anything. Enforced twice — as Claude's `allowedTools`, and again
 * here, which denies every Render tool not on this list.
 */
export const RENDER_READ_ONLY_TOOLS = [
	"list_workspaces",
	"get_selected_workspace",
	"list_services",
	"get_service",
	"list_deploys",
	"get_deploy",
	"list_postgres_instances",
	"get_postgres",
	"list_key_value",
	"get_key_value",
] as const;

export const RENDER_MCP_SERVER = "render";
const RENDER_PREFIX = `mcp__${RENDER_MCP_SERVER}__`;

export interface Rule {
	pattern: RegExp;
	label: string;
}

/** Matched against serialized tool input, so quoting tricks still trip them. */
export const RULES: Rule[] = [
	{
		pattern:
			/\brm\b[^|;]*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\b[^|;]*-f\b|-f\b[^|;]*-r\b|--recursive\b[^|;]*--force\b|--force\b[^|;]*--recursive\b)[^|;]*(?:\/(?:[\s";)|&]|$)|~)/,
		label: "recursive forced deletion of root or home",
	},
	{
		pattern: /\bgit\s+push\b/,
		label: "git push from an agent — the workflow owns publishing",
	},
	{
		pattern: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i,
		label: "destructive SQL statement",
	},
	{ pattern: /\bmkfs\b/, label: "filesystem format" },
	{ pattern: /\bdd\b.*\bif=/, label: "raw disk write (dd)" },
	{
		pattern: />\s*\/dev\/(?:sd|nvme|vd|xvd)/,
		label: "redirect to block device",
	},
	{
		pattern: /\bchmod\b.*(?:777|a\+rwx)\s+\//,
		label: "chmod world-writable on root path",
	},
	{
		pattern:
			/\bcurl\b.*(?:--data\b|-[^\s]*d\b|-X\s*(?:POST|PUT)\b).*(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|RENDER_API_KEY|DATABASE_URL)/i,
		label: "potential secret exfiltration via curl",
	},
	{
		pattern: /\bwget\b.*--post/i,
		label: "potential exfiltration via wget POST",
	},
	{
		pattern: /\bbase64\b.*(?:-d|--decode)\b.*\|\s*(?:sh\b|bash\b|zsh\b)/,
		label: "base64-decoded shell execution",
	},
	{ pattern: /\beval\b.*\$\(/, label: "eval with command substitution" },
	{
		pattern: /\bcurl\b.*\|\s*(?:sh\b|bash\b|zsh\b|source\b)/,
		label: "piped remote shell execution",
	},
	{
		pattern: /\bwget\b.*-O\s*-.*\|\s*(?:sh\b|bash\b|zsh\b)/,
		label: "piped remote shell execution via wget",
	},
];

/** Returns a rejection reason, or null to allow. */
export function checkToolCall(
	name: string,
	input: Record<string, unknown>,
): string | null {
	if (name.startsWith(RENDER_PREFIX)) {
		const tool = name.slice(RENDER_PREFIX.length);
		return isRenderReadOnlyTool(tool)
			? null
			: `Blocked Render MCP tool outside the read-only allowlist: ${tool}`;
	}

	if (PATH_TOOLS.has(name)) {
		const violation = pathEscape(input);
		if (violation) return `Blocked path escape in ${name}: ${violation}`;
	}

	if (CWD_TOOLS.has(name) && typeof input.cwd === "string") {
		const violation = pathEscape({ cwd: input.cwd });
		if (violation) return `Blocked path escape in ${name}: ${violation}`;
	}

	const serialized = JSON.stringify(input);
	for (const rule of RULES) {
		if (rule.pattern.test(serialized)) {
			return `Blocked destructive operation: ${rule.label}`;
		}
	}
	return null;
}

export function isRenderReadOnlyTool(name: string): boolean {
	return (RENDER_READ_ONLY_TOOLS as readonly string[]).includes(name);
}

/** Returns a reason if any string argument escapes the allowed roots. */
export function pathEscape(input: Record<string, unknown>): string | null {
	for (const [key, value] of Object.entries(input)) {
		if (typeof value !== "string" || key === "url") continue;
		const normalized = value.replace(/\/+/g, "/");

		if (normalized.includes("/../") || normalized.startsWith("../")) {
			return "path traversal via ../";
		}
		if (
			normalized.startsWith("/") &&
			!normalized.startsWith(airoConfig.repoDir) &&
			!normalized.startsWith("/tmp/")
		) {
			return `absolute path outside the checkout: ${normalized.slice(0, 60)}`;
		}
	}
	return null;
}

export type ResolvedPath = { path: string } | { error: string };

/**
 * Turn an agent-supplied path into an absolute one inside the checkout.
 *
 * A relative path is resolved against `workDir`, which workflow code owns —
 * never against whatever directory the exec API happens to start in. Without
 * this, `mkdir -p my-app` from an agent lands outside the clone, the run
 * builds a complete application nobody can commit, and nothing reports a
 * failure until the push finds an empty directory.
 */
export function resolveSandboxPath(
	workDir: string,
	path: string,
): ResolvedPath {
	if (!path.trim()) return { error: "Path is empty." };

	const absolute = path.startsWith("/")
		? normalizePosix(path)
		: normalizePosix(`${workDir}/${path}`);

	if (
		isInside(airoConfig.repoDir, absolute) ||
		isInside(SCRATCH_DIR, absolute)
	) {
		return { path: absolute };
	}
	return {
		error: `"${path}" resolves to ${absolute}, outside the checkout (${airoConfig.repoDir}).`,
	};
}

/** Lexical resolution of `.` and `..`. The sandbox has no symlinks we follow. */
function normalizePosix(path: string): string {
	const absolute = path.startsWith("/");
	const parts: string[] = [];

	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment !== "..") {
			parts.push(segment);
			continue;
		}
		if (parts.length > 0 && parts[parts.length - 1] !== "..") {
			parts.pop();
		} else if (!absolute) {
			parts.push("..");
		}
	}

	return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

const SECRET_PATTERNS = [
	/\bsk-ant-api\S{10,}/g,
	/\bghp_\S{10,}/g,
	/\bghs_\S{10,}/g,
	/\bgithub_pat_\S{10,}/g,
	/\brnd_\S{10,}/g,
	/\bAKIA\S{12,}/g,
	/\bsk-\S{20,}/g,
	// Generated apps get a real DATABASE_URL, so redact anything shaped like one.
	/\bpostgres(?:ql)?:\/\/\S+/g,
];

/**
 * Validate that every command in an agent-declared manifest clears the
 * existing destructive-operation rules. Called by the workflow before the
 * manifest's commands reach the sandbox or the Blueprint.
 */
export function checkManifestCommands(
	manifest: { services: { buildCommand?: string; startCommand?: string }[] },
): string | null {
	for (const service of manifest.services) {
		for (const field of ["buildCommand", "startCommand"] as const) {
			const command = service[field];
			if (!command) continue;
			for (const rule of RULES) {
				if (rule.pattern.test(command)) {
					return `Blocked manifest ${field}: ${rule.label}`;
				}
			}
		}
	}
	return null;
}

/** Strip secret-shaped strings. Applied once when text leaves the factory. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

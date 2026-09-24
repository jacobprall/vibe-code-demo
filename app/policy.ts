/** The one gate between a model and the machine. */

/**
 * The input fields of each tool that hold a path. Other fields, such as the
 * content of a file or a shell command, can hold any text.
 */
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
	sandbox__read_file: ["path"],
	sandbox__write_file: ["path"],
	sandbox__list_dir: ["path"],
	sandbox__search: ["path"],
	sandbox__exec: ["cwd"],
	sandbox__apply_patch: ["cwd"],
	asset__fetch: ["path"],
	asset__collect: ["destDir"],
};

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

/**
 * Returns a rejection reason, or null to allow. `workDir` is the app
 * directory of the agent, and each path in a tool call must resolve inside
 * it or /tmp.
 */
export function checkToolCall(
	name: string,
	input: Record<string, unknown>,
	workDir?: string,
): string | null {
	if (name.startsWith(RENDER_PREFIX)) {
		const tool = name.slice(RENDER_PREFIX.length);
		return isRenderReadOnlyTool(tool)
			? null
			: `Blocked Render MCP tool outside the read-only allowlist: ${tool}`;
	}

	for (const field of PATH_FIELDS[name] ?? []) {
		const value = input[field];
		// The tool decides what an omitted or empty path means.
		if (typeof value !== "string" || value === "") continue;
		if (!workDir) return `Blocked ${name}: the agent has no app directory.`;
		const resolved = resolveSandboxPath(workDir, value);
		if ("error" in resolved) {
			return `Blocked path escape in ${name}: ${resolved.error}`;
		}
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

export type ResolvedPath = { path: string } | { error: string };

/**
 * Turn an agent-supplied path into an absolute one inside the app directory
 * or /tmp.
 *
 * A relative path is resolved against `workDir`, which workflow code owns —
 * never against whatever directory the exec API happens to start in. Without
 * this, `mkdir -p my-app` from an agent lands outside the app, the run builds
 * a complete application nobody can commit, and nothing reports a failure
 * until the push finds an empty directory.
 *
 * These rules keep the file tools on one app, but they do not isolate the
 * agent: the resolution is lexical, so a symbolic link can point out, and
 * sandbox__exec runs any command. The sandbox isolates the agent, because it
 * holds only this app and no credential.
 */
export function resolveSandboxPath(
	workDir: string,
	path: string,
): ResolvedPath {
	if (!path.trim()) return { error: "Path is empty." };

	const absolute = path.startsWith("/")
		? normalizePosix(path)
		: normalizePosix(`${workDir}/${path}`);

	if (isInside(workDir, absolute) || isInside(SCRATCH_DIR, absolute)) {
		return { path: absolute };
	}
	return {
		error: `"${path}" resolves to ${absolute}, outside the app directory (${workDir}) and ${SCRATCH_DIR}.`,
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

/**
 * isInside, not startsWith: a sibling like /home/user/repo/apps/demo/shopx
 * shares the prefix of an app directory but is not in it.
 */
export function isInside(root: string, candidate: string): boolean {
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
	manifest: {
		services: {
			buildCommand?: string;
			startCommand?: string;
			preDeployCommand?: string;
		}[];
	},
): string | null {
	for (const service of manifest.services) {
		for (const field of [
			"buildCommand",
			"startCommand",
			"preDeployCommand",
		] as const) {
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

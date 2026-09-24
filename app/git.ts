/**
 * Clone, commit, push, verify — all workflow-owned. Agents never run git.
 *
 * The sandbox of a build gets no clone and no credential. The factory copies
 * the files of the app out of it as data, and commits them in a clone in a
 * different sandbox. Each commit changes only the directory of one app and
 * the root Blueprint.
 *
 * The credential half lives here too. GitHub is only a code substrate: Render's
 * Blueprint deploys from the apps repository, so the one thing the factory
 * needs from GitHub is a token that can push to it. There is no REST client.
 */
import { createSign, randomUUID } from "node:crypto";
import { Parser } from "tar";
import { factoryConfig } from "../factory.config.js";
import type { Manifest } from "./contracts.js";
import { type ExecResult, type Sandbox, shellEscape } from "./sandbox.js";

export const REPO_DIR = factoryConfig.repoDir;

/**
 * The limit of the files of one app. Each service of each app builds from a
 * clone of the apps repository, so a large app makes every deploy slower. The
 * curator downloads at most 24 MB of photographs, and the builder can copy
 * them one time. publish-app holds the files in memory, on the starter plan.
 */
export const MAX_APP_BYTES = 50 * 1024 * 1024;

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** A path segment that a .gitignore pattern matches literally: no globs, no escapes. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_VERIFY_OUTPUT_CHARS = 10_000;
const PUSH_ATTEMPTS = 3;
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** The tar types of a regular file. */
const REGULAR_FILE = new Set(["File", "OldFile", "ContiguousFile"]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Ends each heredoc. Base64 has no "_", so no line of a file can end one. */
const FILE_EOF = "FACTORY_FILE_EOF";

export interface VerificationResult {
	passed: boolean;
	failures: string;
}

export function githubRemoteUrl(owner: string, repo: string): string {
	const unsafe = [owner, repo].some(
		(part) => !GITHUB_SEGMENT.test(part) || part === "." || part === "..",
	);
	if (unsafe) {
		throw new Error(
			"GitHub owner and repository must contain only safe characters",
		);
	}
	return `https://github.com/${owner}/${repo}.git`;
}

/** Run a git subcommand in the clone. Disables repo hooks for safety. */
export function git(
	sandbox: Sandbox,
	subcommand: string,
	label: string,
): Promise<string> {
	return sandbox.mustRun(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} ${subcommand}`,
		label,
	);
}

/**
 * Run one authenticated Git command. The token reaches Git through a
 * temporary GIT_ASKPASS script so it never appears in .git/config or the
 * process listing.
 */
export async function execGitWithToken(
	sandbox: Sandbox,
	token: string,
	args: readonly string[],
): Promise<ExecResult> {
	if (args[0] !== "git") {
		throw new Error("execGitWithToken accepts only git commands");
	}

	const askpassPath = `/tmp/vibe-askpass-${randomUUID()}.sh`;
	// x-access-token is what GitHub expects for App installation tokens, and is
	// accepted as the username for a PAT too.
	await sandbox.upload(
		askpassPath,
		`#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' ${shellEscape(token)} ;;
  *) exit 1 ;;
esac
`,
	);

	try {
		const command = [
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"credential.helper=",
			...args.slice(1),
		]
			.map(shellEscape)
			.join(" ");

		return await sandbox.run(
			`chmod 700 ${shellEscape(askpassPath)} && ` +
				`GIT_ASKPASS=${shellEscape(askpassPath)} GIT_TERMINAL_PROMPT=0 ${command}`,
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(askpassPath)}`).catch(() => {});
	}
}

/**
 * Clone the apps repository. Every run works on the shared branch the
 * Blueprint tracks, because appending to that Blueprint is what deploys.
 *
 * The token enters the sandbox, so the sandbox must be one that no agent has
 * used.
 */
export async function cloneAppsRepo(
	sandbox: Sandbox,
	token: string,
	repo: { owner: string; repo: string },
	branch: string,
): Promise<string> {
	const remoteUrl = githubRemoteUrl(repo.owner, repo.repo);
	const clone = await execGitWithToken(sandbox, token, [
		"git",
		"clone",
		"--depth=1",
		// A symbolic link in the repository becomes a plain file that holds its
		// target. So no write of the factory can follow a link out of the
		// clone, for example to put a different git on the PATH before the push.
		"--config",
		"core.symlinks=false",
		remoteUrl,
		REPO_DIR,
	]);
	if (clone.exitCode !== 0) {
		throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
	}

	// -B rather than checkout so a repository with no commits yet works.
	await git(sandbox, `checkout -B ${shellEscape(branch)}`, "Select branch");
	await git(sandbox, 'config user.name "vibe-factory[bot]"', "Set commit name");
	await git(
		sandbox,
		'config user.email "bot@vibe-factory.dev"',
		"Set commit email",
	);
	return remoteUrl;
}

/**
 * The .gitignore at the root of each app. Render builds every service from a
 * fresh clone, and its buildCommand installs the dependencies and writes the
 * directory a static site publishes. A commit does not need them.
 *
 * The manifest is agent-authored, so a publish directory gets a rule only when
 * it is a plain path below the service's rootDir. "." publishes the source of
 * the service itself, which is how a site without a build works. Every other
 * path gets no rule: a missing rule commits too much, but a wrong rule removes
 * a file that the deploy needs.
 */
export function appGitignore(manifest: Manifest): string {
	const publishDirs = new Set<string>();
	for (const service of manifest.services) {
		// Render reads staticPublishPath only for a static site.
		if (service.kind !== "static_site" || !service.staticPublishPath) continue;
		const rootDir = plainPath(service.rootDir);
		const publishDir = plainPath(service.staticPublishPath);
		if (rootDir === null || !publishDir) continue;
		// Anchored, so that a source directory with the same name deeper in
		// the app stays in the commit.
		publishDirs.add(`/${rootDir ? `${rootDir}/` : ""}${publishDir}/`);
	}

	return [
		"# Generated by the Vibe Code factory. Do not edit by hand.",
		"# Render builds each service from a fresh clone. Its buildCommand makes",
		"# these paths, so a commit does not need them.",
		"node_modules/",
		...[...publishDirs].sort(),
		"",
	].join("\n");
}

/**
 * An agent-supplied relative path as "a/b", "" for the directory itself, or
 * null when it is not a plain relative path.
 */
function plainPath(path: string): string | null {
	if (path.startsWith("/")) return null;
	const segments = path
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	const plain = segments.every(
		(segment) => segment !== ".." && PLAIN_SEGMENT.test(segment),
	);
	return plain ? segments.join("/") : null;
}

/**
 * Delete all that git ignores in a directory. The files that stay are the
 * files a commit holds, which is all that Render's fresh clone gets. -X, not
 * -x: an untracked file that is not ignored is part of the app, so it stays.
 */
export async function removeIgnored(
	sandbox: Sandbox,
	dir: string,
): Promise<void> {
	await sandbox.mustRun(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(dir)} clean -fdXq -- .`,
		"Remove ignored files",
	);
}

/**
 * Commit the changes below the given paths, which are relative to the root of
 * the clone. A change to a different path stays out of the commit. Returns
 * null when nothing changed.
 */
export async function commitPaths(
	sandbox: Sandbox,
	message: string,
	paths: readonly string[],
): Promise<string | null> {
	// git add fails for a path that matches no file, for example the
	// directory of an app that an earlier attempt of its delete removed. So
	// stage all, and then unstage all other paths.
	await git(sandbox, "add -A", "Git add");
	const others = [":(top)", ...paths.map((path) => `:(exclude,literal)${path}`)];
	await git(
		sandbox,
		`reset -q -- ${others.map(shellEscape).join(" ")}`,
		"Unstage other paths",
	);

	const staged = await sandbox.run(
		`git -C ${shellEscape(REPO_DIR)} diff --cached --quiet`,
	);
	if (staged.exitCode === 0) return null;
	if (staged.exitCode !== 1) {
		throw new Error(`Git diff check failed: ${staged.output.slice(0, 500)}`);
	}

	await git(sandbox, `commit -q -m ${shellEscape(message)}`, "Commit");
	return (await git(sandbox, "rev-parse HEAD", "Committed revision")).trim();
}

/**
 * Push the commit at HEAD to the shared branch, then confirm that the remote
 * holds it. Render deploys from this branch, so a mismatch here would mean
 * deploying something unverified.
 *
 * When the push fails, for example because another run pushed first, the
 * clone takes the new tip of the branch, and `redo` makes the same change
 * and commit on it. Each change of the factory is derived from its inputs,
 * so it applies to any tip, and no merge is necessary. `redo` returns the
 * new commit, or null when the tip already holds the change.
 *
 * The push stops before it sends a commit that changes a path outside
 * `paths`, which are relative to the root of the clone.
 */
export async function pushVerified(
	sandbox: Sandbox,
	token: string,
	remoteUrl: string,
	branch: string,
	paths: readonly string[],
	redo: () => Promise<string | null>,
): Promise<string> {
	const ref = `refs/heads/${branch}`;

	for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
		// Before each attempt, because a new attempt makes a new commit.
		await checkCommitPaths(sandbox, paths);
		const push = await execGitWithToken(sandbox, token, [
			"git",
			"-C",
			REPO_DIR,
			"push",
			remoteUrl,
			`HEAD:${ref}`,
		]);
		if (push.exitCode === 0) break;

		if (attempt === PUSH_ATTEMPTS) {
			throw new Error(`Push failed: ${push.output.slice(0, 500)}`);
		}
		await takeTip(sandbox, token, remoteUrl, branch);
		// A push can reach the remote although git reports a failure. Then
		// the tip that the clone took already holds the change.
		if (!(await redo())) return headRevision(sandbox);
	}

	const head = await headRevision(sandbox);
	const remote = await execGitWithToken(sandbox, token, [
		"git",
		"ls-remote",
		remoteUrl,
		ref,
	]);
	if (remote.exitCode !== 0) {
		throw new Error(`Push verification failed: ${remote.output.slice(0, 500)}`);
	}
	if (remote.output.trim().split(/\s+/)[0] !== head) {
		throw new Error("Pushed branch SHA does not match the local commit");
	}
	return head;
}

/**
 * Set the clone to the newest commit of the branch. This drops the commit
 * of the failed push, and its change in the files that the clone tracks.
 */
async function takeTip(
	sandbox: Sandbox,
	token: string,
	remoteUrl: string,
	branch: string,
): Promise<void> {
	const fetched = await execGitWithToken(sandbox, token, [
		"git",
		"-C",
		REPO_DIR,
		"fetch",
		"-q",
		"--depth=1",
		remoteUrl,
		branch,
	]);
	if (fetched.exitCode !== 0) {
		throw new Error(`Fetch of ${branch} failed: ${fetched.output.slice(0, 500)}`);
	}
	await git(sandbox, "reset -q --hard FETCH_HEAD", "Take the tip of the branch");
}

async function headRevision(sandbox: Sandbox): Promise<string> {
	return (await git(sandbox, "rev-parse HEAD", "Pushed revision")).trim();
}

/**
 * Refuse a commit that changes a path outside `paths`. A push adds one
 * commit, at HEAD: commitPaths() makes it on the tip of the clone.
 */
async function checkCommitPaths(
	sandbox: Sandbox,
	paths: readonly string[],
): Promise<void> {
	// -m, so that a merge commit also shows what it changes.
	const listed = await git(
		sandbox,
		"diff-tree -m -r -z --root --no-renames --no-commit-id --name-only HEAD",
		"List the paths that the commit changes",
	);
	// Each path ends with a NUL. Without them, two paths would join into one
	// that can start with an allowed path.
	if (listed !== "" && !listed.endsWith("\0")) {
		throw new Error(
			`The list of the paths that the commit changes has no NUL terminators, so the commit was not pushed: ${listed.slice(0, 200)}`,
		);
	}
	const outside = listed
		.split("\0")
		.filter(
			(changed) =>
				changed !== "" &&
				!paths.some(
					(path) => changed === path || changed.startsWith(`${path}/`),
				),
		);
	if (outside.length > 0) {
		throw new Error(
			`The commit changes paths outside ${paths.join(" and ")}, so it was not pushed: ${outside.slice(0, 10).join(", ")}`,
		);
	}
}

/** Run commands in a directory and summarize failures. */
export async function runVerification(
	sandbox: Sandbox,
	dir: string,
	commands: readonly string[],
): Promise<VerificationResult> {
	const failures: string[] = [];

	for (const command of commands) {
		const { output, exitCode } = await sandbox.run(
			`cd ${shellEscape(dir)} && ${command}`,
		);
		if (exitCode !== 0) {
			failures.push(
				`Command: ${command}\nExit code: ${exitCode}\nOutput:\n${output.slice(0, MAX_VERIFY_OUTPUT_CHARS)}`,
			);
		}
	}

	return {
		passed: failures.length === 0,
		failures: failures.join("\n\n---\n\n"),
	};
}

/* ── The files of an app ──────────────────────────────────────────────── */

/** A file of an app, as the factory copies it out of the sandbox of its build. */
export interface AppFile {
	/** Relative to the app directory. */
	path: string;
	data: Buffer;
	executable: boolean;
}

/**
 * The files of an app, or why the factory does not copy them. The error is
 * for the builder: verify-app gives it to the builder to fix.
 */
export type AppFiles = { files: AppFile[] } | { error: string };

/**
 * Make the app directory in the sandbox of a build, in a new repository with
 * no remote. The sandbox gets no clone of the apps repository and no
 * credential. Git in it only tells which files a commit of the app holds:
 * removeIgnored() deletes the others, and readAppFiles() packs these.
 */
export async function initAppDir(
	sandbox: Sandbox,
	appDir: string,
): Promise<void> {
	await sandbox.mustRun(
		`git init -q ${shellEscape(REPO_DIR)} && mkdir -p ${shellEscape(appDir)}`,
		"Create the app directory",
	);
}

/**
 * Read the files that a commit of the app holds out of the sandbox of its
 * build. The builder can run any command in that sandbox, so this is data
 * that nothing trusts: appFiles() accepts only regular files with plain paths
 * below the app directory.
 */
export async function readAppFiles(
	sandbox: Sandbox,
	appDir: string,
): Promise<AppFiles> {
	const base = `/tmp/vibe-app-${randomUUID()}`;
	const list = shellEscape(`${base}.list`);
	const archive = shellEscape(`${base}.tar`);
	try {
		const packed = await sandbox.run(
			`cd ${shellEscape(appDir)} && ` +
				// An index that does not exist, so that git lists each file that
				// a first commit holds, also a file that the builder staged.
				`GIT_INDEX_FILE=${shellEscape(`${base}.index`)} git ls-files -z --others --exclude-standard >${list} && ` +
				`tar --null --no-recursion -T ${list} -cf ${archive} && ` +
				`wc -c <${archive}`,
		);
		// For example, a process of the builder changed a file during the pack.
		if (packed.exitCode !== 0) {
			return {
				error: `The files of the app could not be packed: ${packed.output.slice(0, 1_000)}`,
			};
		}
		// Stop an archive that is too large before the download.
		const size = Number(packed.output.trim().split("\n").at(-1));
		if (size > MAX_APP_BYTES) return { error: tooLarge(size) };
		return await appFiles(await sandbox.download(`${base}.tar`));
	} finally {
		await sandbox.run(`rm -f ${list} ${archive}`).catch(() => {});
	}
}

/** The files in a tar archive of an app, or why the factory does not copy them. */
export async function appFiles(archive: Buffer): Promise<AppFiles> {
	if (archive.byteLength > MAX_APP_BYTES) {
		return { error: tooLarge(archive.byteLength) };
	}
	// readAppFiles() packs a plain tar. A compressed archive can expand in
	// memory to much more than the limit.
	if (
		archive.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC) ||
		archive.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
	) {
		return { error: "The archive of the app is compressed." };
	}

	let entries: TarEntry[];
	try {
		entries = await tarEntries(archive);
	} catch (error) {
		return {
			error: `The archive of the app is not a valid tar archive: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const files: AppFile[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const error = entryError(entry, seen);
		if (error) return { error };
		seen.add(entry.path);
		// Git keeps only the executable bit of the owner.
		files.push({
			path: entry.path,
			data: entry.data,
			executable: (entry.mode & 0o100) !== 0,
		});
	}
	if (files.length === 0) {
		return { error: "No file in the app directory goes into a commit." };
	}
	return { files };
}

interface TarEntry {
	path: string;
	type: string;
	mode: number;
	data: Buffer;
}

function tarEntries(archive: Buffer): Promise<TarEntry[]> {
	return new Promise((resolve, reject) => {
		const entries: TarEntry[] = [];
		const parser = new Parser({
			// A damaged entry is an error, not a warning that skips the entry.
			strict: true,
			onReadEntry: (entry) => {
				const chunks: Buffer[] = [];
				entry.on("data", (chunk: Buffer) => chunks.push(chunk));
				entry.on("end", () =>
					entries.push({
						path: entry.path,
						type: entry.type,
						mode: entry.mode ?? 0,
						data: Buffer.concat(chunks),
					}),
				);
			},
		});
		parser.on("error", reject);
		parser.on("end", () => resolve(entries));
		parser.end(archive);
	});
}

/** Why the factory does not copy an entry of the archive, or null. */
function entryError(
	entry: TarEntry,
	seen: ReadonlySet<string>,
): string | null {
	if (/\p{Cc}/u.test(entry.path)) {
		return `${JSON.stringify(entry.path)} has a control character in its name.`;
	}
	const path = entry.path.replace(/\/+$/, "");
	// git ls-files gives a Git repository in the app as one directory.
	if (entry.type === "Directory") {
		return `${path} is a Git repository in the app directory. Remove ${path}/.git, so that a commit holds its files.`;
	}
	if (entry.type === "SymbolicLink") {
		return `${path} is a symbolic link. Only regular files are published: replace the link with a copy of the file or directory that it points to.`;
	}
	if (!REGULAR_FILE.has(entry.type)) {
		return `${path} is a ${entry.type} entry. Only regular files are published.`;
	}
	const segments = entry.path.split("/");
	if (
		entry.path.startsWith("/") ||
		segments.some((segment) => ["", ".", ".."].includes(segment))
	) {
		return `${entry.path} is not a plain path below the app directory.`;
	}
	if (segments.some((segment) => segment.toLowerCase() === ".git")) {
		return `${entry.path} is in a .git directory. No file from a .git directory is published.`;
	}
	if (seen.has(entry.path)) {
		return `${entry.path} is in the archive two times.`;
	}
	return null;
}

function tooLarge(bytes: number): string {
	const mb = (value: number) => Math.ceil(value / (1024 * 1024));
	return (
		`The files of the app are ${mb(bytes)} MB, and the limit is ${mb(MAX_APP_BYTES)} MB. ` +
		"Remove large files, and files that are in the app two times."
	);
}

/**
 * Replace the app directory of a clone with the files of the build. One
 * script writes them all, as materializeTemplate() writes a template, and
 * base64 carries each file, so that binary data comes through unchanged.
 */
export async function writeAppFiles(
	sandbox: Sandbox,
	appDir: string,
	files: readonly AppFile[],
): Promise<void> {
	const scriptPath = `/tmp/vibe-app-${randomUUID()}.sh`;
	await sandbox.upload(scriptPath, appFilesScript(files, appDir));
	try {
		await sandbox.mustRun(
			`sh ${shellEscape(scriptPath)}`,
			"Write the files of the app",
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(scriptPath)}`).catch(() => {});
	}
}

/**
 * The script that writeAppFiles() runs. Each path is a plain relative path
 * from appFiles(), and the directory is new. So each file goes below the app
 * directory: no symbolic link is there to follow.
 */
function appFilesScript(files: readonly AppFile[], appDir: string): string {
	// "./" first, so that no command reads a path such as "-rf" as an option.
	const local = (path: string) => shellEscape(`./${path}`);
	const directories = new Set<string>();
	for (const { path } of files) {
		const slash = path.lastIndexOf("/");
		if (slash > 0) directories.add(path.slice(0, slash));
	}

	const lines = [
		"set -e",
		`rm -rf ${shellEscape(appDir)}`,
		`mkdir -p ${shellEscape(appDir)}`,
		`cd ${shellEscape(appDir)}`,
	];
	if (directories.size > 0) {
		lines.push(`mkdir -p ${[...directories].sort().map(local).join(" ")}`);
	}
	for (const file of files) {
		// One string for each file, with a line break after each 76 characters.
		// An array of short lines takes much more memory.
		const base64 = file.data
			.toString("base64")
			.replace(/.{76}(?=.)/g, "$&\n");
		lines.push(
			`base64 -d >${local(file.path)} <<'${FILE_EOF}'`,
			base64,
			FILE_EOF,
		);
		if (file.executable) lines.push(`chmod 755 ${local(file.path)}`);
	}
	return `${lines.join("\n")}\n`;
}

/* ── Credentials ──────────────────────────────────────────────────────── */

interface AppCredentials {
	appId: string;
	privateKey: string;
	installationId: string;
}

let cachedToken: { token: string; expiresAt: number } | undefined;

function appCredentials(): AppCredentials | null {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (!appId || !privateKey || !installationId) return null;
	return { appId, privateKey: normalizePrivateKey(privateKey), installationId };
}

/**
 * Accept the PEM as-is, with escaped newlines, or base64-encoded — env vars
 * make real newlines awkward and every deployment tool escapes them
 * differently.
 */
function normalizePrivateKey(value: string): string {
	if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
	return Buffer.from(value, "base64").toString("utf8");
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/** Short-lived JWT proving we hold the app's private key. */
function appJwt({ appId, privateKey }: AppCredentials): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	// Backdated for clock skew; GitHub rejects an exp more than 10 minutes out.
	const payload = base64url(
		JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
	);

	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
}

async function installationToken(
	credentials: AppCredentials,
	fetchImpl: typeof fetch,
): Promise<{ token: string; expiresAt: number }> {
	const response = await fetchImpl(
		`${GITHUB_API}/app/installations/${credentials.installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${appJwt(credentials)}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "vibe-factory",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`GitHub App token exchange failed (${response.status}): ${body.slice(0, 300)}`,
		);
	}

	const body = (await response.json()) as { token: string; expires_at: string };
	return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/**
 * The token to authenticate with. Installation tokens are cached and renewed
 * before they expire, because a run can outlive the one-hour lifetime.
 */
export async function githubToken(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const credentials = appCredentials();

	if (!credentials) {
		const pat = process.env.GITHUB_TOKEN?.trim();
		if (!pat) {
			throw new Error(
				"No GitHub credentials. Set GITHUB_TOKEN, or GITHUB_APP_ID, " +
					"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
			);
		}
		return pat;
	}

	if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
		return cachedToken.token;
	}
	cachedToken = await installationToken(credentials, fetchImpl);
	return cachedToken.token;
}

/** True when the factory acts as a GitHub App rather than a user. */
export function usingGitHubApp(): boolean {
	return appCredentials() !== null;
}

/** Test seam. */
export function resetTokenCache(): void {
	cachedToken = undefined;
}

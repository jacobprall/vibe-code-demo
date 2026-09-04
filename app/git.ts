/**
 * Clone, commit, push, verify — all workflow-owned. Agents never run git.
 *
 * The credential half lives here too. GitHub is only a code substrate: Render's
 * Blueprint deploys from the apps repository, so the one thing the factory
 * needs from GitHub is a token that can push to it. There is no REST client.
 */
import { createSign, randomUUID } from "node:crypto";
import { airoConfig } from "../airo.config.js";
import { type ExecResult, type Sandbox, shellEscape } from "./sandbox.js";

export const REPO_DIR = airoConfig.repoDir;

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_VERIFY_OUTPUT_CHARS = 10_000;
const PUSH_ATTEMPTS = 3;
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

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

	const askpassPath = `/tmp/airo-askpass-${randomUUID()}.sh`;
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
		remoteUrl,
		REPO_DIR,
	]);
	if (clone.exitCode !== 0) {
		throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
	}

	// -B rather than checkout so a repository with no commits yet works.
	await git(sandbox, `checkout -B ${shellEscape(branch)}`, "Select branch");
	await git(sandbox, 'config user.name "airo-factory[bot]"', "Set commit name");
	await git(
		sandbox,
		'config user.email "bot@airo-factory.dev"',
		"Set commit email",
	);
	return remoteUrl;
}

/** Commit everything in the clone. Returns null when nothing changed. */
export async function commitAll(
	sandbox: Sandbox,
	message: string,
): Promise<string | null> {
	await git(sandbox, "add -A", "Git add");

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
 * Rewrites the files a rebase must recompute rather than merge, and returns
 * the repository-relative paths it owns. Anything else still conflicting is
 * a real conflict and aborts the rebase.
 */
export type RebaseResolver = () => Promise<readonly string[]>;

/**
 * Push to the shared branch, rebasing if another run got there first, then
 * confirm the remote holds the commit we verified. Render deploys from this
 * branch, so a mismatch here would mean deploying something unverified.
 */
export async function pushVerified(
	sandbox: Sandbox,
	token: string,
	remoteUrl: string,
	branch: string,
	resolveRebase?: RebaseResolver,
): Promise<string> {
	const ref = `refs/heads/${branch}`;

	for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
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
		// Another run appended its app to the Blueprint first. Replay ours on
		// top and try again.
		const rebase = await execGitWithToken(sandbox, token, [
			"git",
			"-C",
			REPO_DIR,
			"pull",
			"--rebase",
			remoteUrl,
			branch,
		]);
		if (rebase.exitCode !== 0) {
			await finishRebase(sandbox, branch, rebase.output, resolveRebase);
		}
	}

	const head = (await git(sandbox, "rev-parse HEAD", "Pushed revision")).trim();
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
 * A rebase stopped on a conflict. Generated files are recomputed rather than
 * merged: the repository-root Blueprint holds every app the factory has built,
 * so two concurrent runs rewrite the same lines and git can never resolve it
 * — the loser used to fail after building and verifying an app successfully.
 */
async function finishRebase(
	sandbox: Sandbox,
	branch: string,
	output: string,
	resolve?: RebaseResolver,
): Promise<void> {
	const abort = async (reason: string): Promise<never> => {
		await sandbox
			.run(`git -C ${shellEscape(REPO_DIR)} rebase --abort`)
			.catch(() => {});
		throw new Error(reason);
	};

	if (!resolve) {
		return abort(`Rebase onto ${branch} failed: ${output.slice(0, 500)}`);
	}

	const conflicted = await conflictedPaths(sandbox);
	if (conflicted.length === 0) {
		return abort(`Rebase onto ${branch} failed: ${output.slice(0, 500)}`);
	}

	const regenerated = new Set(await resolve());
	const unresolved = conflicted.filter((path) => !regenerated.has(path));
	if (unresolved.length > 0) {
		return abort(
			`Rebase onto ${branch} conflicted outside generated files: ${unresolved.join(", ")}`,
		);
	}

	await git(sandbox, "add -A", "Stage regenerated files");
	// GIT_EDITOR: --continue reuses the original message, but git still opens an
	// editor for it, and there is no terminal here.
	const done = await sandbox.run(
		`GIT_EDITOR=true git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} rebase --continue`,
	);
	if (done.exitCode !== 0) {
		return abort(`Rebase onto ${branch} could not continue: ${done.output.slice(0, 500)}`);
	}
}

async function conflictedPaths(sandbox: Sandbox): Promise<string[]> {
	const listed = await git(
		sandbox,
		"diff --name-only --diff-filter=U",
		"List conflicted paths",
	);
	return listed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
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
				"User-Agent": "airo-factory",
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

/** Environment parsing and per-process validation. */

const REPO_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const USER_SLUG_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

export interface Repository {
	owner: string;
	repo: string;
	fullName: string;
	/** The clone URL a Blueprint's `repo` field points at. */
	url: string;
}

export function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/**
 * The one repository generated apps live in. Every run adds a directory under
 * apps/<user>/<app> and updates the Blueprint at the repository root; Render
 * syncs that Blueprint and deploys what changed.
 */
export function appsRepo(): Repository {
	const fullName = requireEnv("APPS_REPO");
	if (!REPO_PATTERN.test(fullName)) {
		throw new Error("APPS_REPO must use owner/repo format");
	}
	const [owner, repo] = fullName.split("/");
	if (repo === "." || repo === "..") {
		throw new Error("APPS_REPO must use owner/repo format");
	}
	return {
		owner,
		repo,
		fullName,
		url: `https://github.com/${owner}/${repo}`,
	};
}

/** The bearer token callers present to the public API. */
export function apiKey(): string {
	const key = requireEnv("FACTORY_API_KEY");
	if (key.length < 24) {
		throw new Error("FACTORY_API_KEY must be at least 24 characters");
	}
	return key;
}

export function uiCredentials(): { username: string; password: string } {
	const username = requireEnv("UI_USERNAME");
	const password = requireEnv("UI_PASSWORD");
	if (!USER_SLUG_PATTERN.test(username)) {
		throw new Error("UI_USERNAME must be a lowercase slug");
	}
	if (password.length < 16) {
		throw new Error("UI_PASSWORD must be at least 16 characters");
	}
	return { username, password };
}

export function renderWorkspaceId(): string {
	return requireEnv("RENDER_WORKSPACE_ID");
}

/** Either a GitHub App installation or a fine-grained PAT, not neither. */
function requireGitHubCredentials(): void {
	const app =
		process.env.GITHUB_APP_ID?.trim() &&
		process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
		process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (app || process.env.GITHUB_TOKEN?.trim()) return;

	throw new Error(
		"No GitHub credentials. Set GITHUB_TOKEN, or GITHUB_APP_ID, " +
			"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
	);
}

/** Fail fast if the gateway is misconfigured. */
export function assertGatewayEnv(): void {
	apiKey();
	uiCredentials();
	requireEnv("RENDER_WORKFLOW_SLUG");
	// The Render SDK reads this when the gateway dispatches a workflow task.
	requireEnv("RENDER_API_KEY");
	requireEnv("DATABASE_URL");
}

/** Fail fast if the workflows host is misconfigured. */
export function assertWorkflowEnv(): void {
	appsRepo();
	requireEnv("ANTHROPIC_API_KEY");
	requireGitHubCredentials();
	// Sandboxes, the Render MCP server, and reading Blueprint state.
	requireEnv("RENDER_API_KEY");
	requireEnv("RENDER_WORKSPACE_ID");
	requireEnv("DATABASE_URL");
}

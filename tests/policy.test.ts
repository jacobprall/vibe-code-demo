import { describe, expect, it } from "vitest";
import {
	checkToolCall,
	redactSecrets,
	resolveSandboxPath,
} from "../app/policy.js";

const APP_DIR = "/home/user/repo/apps/demo/shop";

const exec = (command: string) =>
	checkToolCall("sandbox__exec", { command }, APP_DIR);
const tool = (name: string, input: Record<string, unknown>) =>
	checkToolCall(name, input, APP_DIR);

describe("checkToolCall", () => {
	// A pattern cannot tell a safe command from a harmful one: a regex list
	// refused `rm -rf dist/`, and let `r''m -rf /` through. The sandbox holds
	// no credential, and it has no remote to push to.
	it.each([
		"npm test",
		"rm -rf dist/ && mkdir -p dist",
		"psql \"$DATABASE_URL\" -c 'DROP TABLE IF EXISTS items'",
		"git push origin HEAD",
	])("does not read the command %s", (command) => {
		expect(exec(command)).toBeNull();
	});

	it("blocks path traversal in file tools", () => {
		expect(
			tool("sandbox__write_file", { path: "../../etc/passwd", content: "x" }),
		).toContain("outside the app directory");
	});

	it("blocks a sibling directory that merely shares the app directory's prefix", () => {
		expect(
			tool("sandbox__read_file", { path: "/home/user/repo/apps/demo/shopx/x.ts" }),
		).toContain("outside the app directory");
	});

	it("blocks absolute paths outside the app directory", () => {
		expect(tool("sandbox__read_file", { path: "/etc/shadow" })).toContain(
			"outside the app directory",
		);
	});

	// The builder once wrote to the apps of other users, and to the files at
	// the root of the apps repository.
	it.each([
		["sandbox__write_file", { path: "../../victim/site/index.html", content: "x" }],
		["sandbox__write_file", { path: "/home/user/repo/render.yaml", content: "x" }],
		["sandbox__read_file", { path: "/home/user/repo/apps/victim/site/factory.json" }],
		["sandbox__list_dir", { path: ".." }],
		["sandbox__search", { pattern: "token", path: "/home/user/repo" }],
		["sandbox__exec", { command: "ls", cwd: "../../victim/site" }],
		["sandbox__apply_patch", { diff: "--- a\n+++ b\n", cwd: "/home/user/repo" }],
		["asset__collect", { subjects: ["walnut chair"], destDir: "/home/user/repo/apps/victim/site/assets" }],
	])("blocks %s outside the app directory: %j", (name, input) => {
		expect(tool(name, input)).toContain("outside the app directory");
	});

	it("allows paths inside the app directory and /tmp", () => {
		expect(tool("sandbox__read_file", { path: `${APP_DIR}/x.ts` })).toBeNull();
		expect(tool("sandbox__read_file", { path: "/tmp/scratch" })).toBeNull();
		expect(tool("sandbox__read_file", { path: "src/index.ts" })).toBeNull();
		expect(tool("sandbox__list_dir", { path: "web/../api" })).toBeNull();
		expect(tool("sandbox__search", { pattern: "x" })).toBeNull();
	});

	// The content of a file is not a path. A JavaScript file can start with
	// "//", and an import can hold "../".
	it("checks only the fields that hold a path", () => {
		expect(
			tool("sandbox__write_file", {
				path: "web/src/main.ts",
				content: '// Entry point.\nimport { api } from "../lib/../api";\n',
			}),
		).toBeNull();
	});

	// An agent with sandbox tools always has an app directory. Without one,
	// no path is inside it.
	it("blocks a path tool when the agent has no app directory", () => {
		expect(checkToolCall("sandbox__read_file", { path: "index.html" })).toContain(
			"has no app directory",
		);
	});

	// The bare name matters: Claude reports MCP tools as mcp__factory__<name>,
	// and claude.ts strips that prefix before calling this.
	it("applies path rules to the bare tool name", () => {
		expect(tool("sandbox__list_dir", { path: "/etc" })).toContain("Blocked");
	});

	it("blocks a cwd outside the app directory without reading the command", () => {
		expect(tool("sandbox__exec", { command: "ls", cwd: "/root" })).toContain(
			"outside the app directory",
		);
		// Absolute paths in the command itself are normal (/usr/bin, /tmp).
		expect(tool("sandbox__exec", { command: "/usr/bin/env node -v" })).toBeNull();
	});

	// asset__fetch takes a URL as well as a path; the URL is not a path.
	it("checks the destination path of an asset fetch without rejecting its URL", () => {
		expect(
			tool("asset__fetch", {
				url: "https://upload.wikimedia.org/a/b.jpg",
				path: "/home/user/repo/apps/demo/shop/web/public/assets/b.jpg",
			}),
		).toBeNull();
		expect(
			tool("asset__fetch", {
				url: "https://upload.wikimedia.org/a/b.jpg",
				path: "/etc/cron.d/payload",
			}),
		).toContain("Blocked");
	});
});

/**
 * The whole reason this exists: the sandbox exec API starts in `/`, so an
 * unresolved relative path builds an application nobody can commit.
 */
describe("resolveSandboxPath", () => {
	const resolved = (path: string) => resolveSandboxPath(APP_DIR, path);

	it.each([
		["web/index.html", `${APP_DIR}/web/index.html`],
		[".", APP_DIR],
		["./api/../web", `${APP_DIR}/web`],
		[`${APP_DIR}/api`, `${APP_DIR}/api`],
		["/tmp/scratch.json", "/tmp/scratch.json"],
	])("resolves %s", (input, expected) => {
		expect(resolved(input)).toEqual({ path: expected });
	});

	it.each([
		"/root",
		"/etc/passwd",
		"../../../../../../root/app",
		"/home/user/repox",
		// The rest of the apps repository is not part of the app.
		"..",
		"../cafe/index.html",
		"/home/user/repo/render.yaml",
		"/home/user/repo/apps/victim/site",
		"/home/user/repo/apps/demo/shopx",
		"/tmpx/scratch.json",
	])("rejects %s", (input) => {
		const result = resolved(input);
		expect("error" in result && result.error).toContain(
			`outside the app directory (${APP_DIR}) and /tmp`,
		);
	});

	it("rejects an empty path", () => {
		expect(resolved("  ")).toEqual({ error: "Path is empty." });
	});
});

/**
 * The architect reaches Render over MCP. Read tools are how it learns what the
 * workspace holds; write tools would let a model change infrastructure.
 */
describe("Render MCP allowlist", () => {
	it("allows read tools", () => {
		expect(checkToolCall("mcp__render__list_services", {})).toBeNull();
		expect(
			checkToolCall("mcp__render__get_service", { serviceId: "srv-1" }),
		).toBeNull();
	});

	it.each([
		"mcp__render__create_static_site",
		"mcp__render__create_web_service",
		"mcp__render__create_postgres",
		"mcp__render__update_environment_variables",
		"mcp__render__trigger_deploy",
	])("blocks %s", (name) => {
		expect(checkToolCall(name, {})).toContain("read-only allowlist");
	});
});

describe("redactSecrets", () => {
	it("removes token-shaped strings", () => {
		const text = "token ghp_abcdefghijklmnopqrst and key sk-ant-api03-abcdefghijkl";
		const redacted = redactSecrets(text);
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrst");
		expect(redacted).not.toContain("sk-ant-api03-abcdefghijkl");
		expect(redacted).toContain("[REDACTED]");
	});

	it("leaves ordinary prose alone", () => {
		expect(redactSecrets("Added a test for the parser.")).toBe(
			"Added a test for the parser.",
		);
	});
});

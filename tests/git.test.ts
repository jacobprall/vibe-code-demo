import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Service } from "../app/contracts.js";
import { appGitignore, pushVerified, removeIgnored } from "../app/git.js";
import { type ExecResult, type Sandbox, shellEscape } from "../app/sandbox.js";

const OK: ExecResult = { output: "", exitCode: 0 };
const HEAD = "a".repeat(40);

/**
 * A sandbox that answers git from a handler and records every command, so a
 * test can assert on the sequence the push actually ran. Unmatched commands
 * succeed silently, which is what the uninteresting plumbing does.
 */
function fakeSandbox(handler: (command: string) => ExecResult | undefined) {
	const commands: string[] = [];

	const run = vi.fn(async (command: string): Promise<ExecResult> => {
		commands.push(command);
		return handler(command) ?? OK;
	});

	const sandbox = {
		run,
		upload: vi.fn(async () => undefined),
		async mustRun(command: string, label: string): Promise<string> {
			const result = await run(command);
			if (result.exitCode !== 0) throw new Error(`${label} failed`);
			return result.output;
		},
	} as unknown as Sandbox;

	return { sandbox, commands };
}

const isPush = (command: string) => / 'push' /.test(command);
const isPull = (command: string) => / 'pull' /.test(command);
const isConflictList = (command: string) =>
	command.includes("--diff-filter=U");

/** Answers for the verification that follows a successful push. */
function verified(command: string): ExecResult | undefined {
	if (command.includes("rev-parse HEAD")) {
		return { output: `${HEAD}\n`, exitCode: 0 };
	}
	if (command.includes("ls-remote")) {
		return { output: `${HEAD}\trefs/heads/main\n`, exitCode: 0 };
	}
	return undefined;
}

const push = (sandbox: Sandbox, resolve?: () => Promise<readonly string[]>) =>
	pushVerified(sandbox, "token", "https://github.com/o/r.git", "main", resolve);

/**
 * The root Blueprint holds every app the factory has built, so a concurrent
 * run's push makes it conflict every time. It is generated from each app's
 * factory.json, so it is recomputed rather than merged — without this, the run
 * that lost the race failed after building and verifying an app successfully.
 */
describe("pushVerified rebase conflicts", () => {
	it("recomputes a generated file and continues the rebase", async () => {
		let rebased = false;
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPull(command)) {
				rebased = true;
				return { output: "CONFLICT (content): render.yaml", exitCode: 1 };
			}
			// The retry lands once our commit sits on top of theirs.
			if (isPush(command)) {
				return rebased ? OK : { output: "non-fast-forward", exitCode: 1 };
			}
			if (isConflictList(command)) {
				return { output: "render.yaml\n", exitCode: 0 };
			}
			return verified(command);
		});

		const resolve = vi.fn(async () => ["render.yaml"]);
		await expect(push(sandbox, resolve)).resolves.toBe(HEAD);

		expect(resolve).toHaveBeenCalledOnce();
		expect(commands.some((c) => c.includes("rebase --continue"))).toBe(true);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(false);
	});

	it("names the file and aborts when a real conflict is mixed in", async () => {
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPush(command)) return { output: "non-fast-forward", exitCode: 1 };
			if (isPull(command)) return { output: "CONFLICT", exitCode: 1 };
			if (isConflictList(command)) {
				return {
					output: "render.yaml\napps/demo/shop/index.html\n",
					exitCode: 0,
				};
			}
			return verified(command);
		});

		await expect(push(sandbox, async () => ["render.yaml"])).rejects.toThrow(
			/apps\/demo\/shop\/index\.html/,
		);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(true);
	});

	it("aborts rather than leaving a rebase in progress with no resolver", async () => {
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPush(command)) return { output: "non-fast-forward", exitCode: 1 };
			if (isPull(command)) return { output: "CONFLICT", exitCode: 1 };
			return verified(command);
		});

		await expect(push(sandbox)).rejects.toThrow(/Rebase onto main failed/);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(true);
	});

	it("does not touch the resolver when the first push succeeds", async () => {
		const { sandbox, commands } = fakeSandbox(verified);
		const resolve = vi.fn(async () => ["render.yaml"]);

		await expect(push(sandbox, resolve)).resolves.toBe(HEAD);
		expect(resolve).not.toHaveBeenCalled();
		expect(commands.some((c) => isPull(c))).toBe(false);
	});

	it("still refuses a remote SHA that does not match the local commit", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.includes("rev-parse HEAD")) {
				return { output: `${HEAD}\n`, exitCode: 0 };
			}
			if (command.includes("ls-remote")) {
				return { output: `${"b".repeat(40)}\trefs/heads/main\n`, exitCode: 0 };
			}
			return undefined;
		});

		await expect(push(sandbox)).rejects.toThrow(/does not match/);
	});
});

/* ── What a commit holds ──────────────────────────────────────────────── */

/** Like most apps in the apps repository: the build only copies files. */
const copyOnlySite: Service = {
	name: "retreat",
	kind: "static_site",
	rootDir: ".",
	runtime: "static",
	buildCommand:
		"mkdir -p dist && cp *.html style.css dist/ && cp -r assets dist/",
	staticPublishPath: "dist",
};

/** The manifest that templates/fullstack tells the builder to return. */
const templateWeb: Service = {
	name: "web",
	kind: "static_site",
	rootDir: "web",
	runtime: "static",
	buildCommand: "npm ci && npm run build",
	staticPublishPath: "dist",
};

const templateApi: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm ci && npm run build",
	preDeployCommand: "npm run migrate",
	startCommand: "npm start",
	healthCheckPath: "/health",
	dataCheckPath: "/api/items",
};

/** The patterns, without the header. */
function rules(...services: Service[]): string[] {
	return appGitignore({ services })
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("#"));
}

describe("appGitignore", () => {
	it("ignores the dependencies and the output of a copy-only build", () => {
		expect(rules(copyOnlySite)).toEqual(["node_modules/", "/dist/"]);
	});

	it("ignores the storefront output of the full-stack template", () => {
		expect(rules(templateWeb, templateApi)).toEqual([
			"node_modules/",
			"/web/dist/",
		]);
	});

	// A site without a build serves its own source, and several apps in the
	// apps repository do. A rule here would leave the whole app out.
	it("never ignores the directory of the service itself", () => {
		for (const [rootDir, staticPublishPath] of [
			[".", "."],
			[".", "./"],
			[".", ""],
			["web", "."],
			["./web/", "./"],
		]) {
			expect(rules({ ...copyOnlySite, rootDir, staticPublishPath })).toEqual(
				["node_modules/"],
			);
		}
	});

	it("reads each spelling of a directory as one path", () => {
		for (const [rootDir, staticPublishPath] of [
			["web", "dist"],
			["./web", "./dist"],
			["web/", "dist/"],
			["./web//", ".//dist//"],
		]) {
			expect(rules({ ...templateWeb, rootDir, staticPublishPath })).toEqual([
				"node_modules/",
				"/web/dist/",
			]);
		}
	});

	// The manifest is agent-authored. A missing rule commits too much, but a
	// wrong rule removes a file that the deploy needs.
	it("gives no rule for a path that it cannot match literally", () => {
		for (const staticPublishPath of [
			"../dist",
			"dist/../..",
			"/home/user/repo/dist",
			"*",
			"**/dist",
			"!dist",
			"#dist",
			"public site",
			"dist\\",
		]) {
			expect(rules({ ...copyOnlySite, staticPublishPath })).toEqual([
				"node_modules/",
			]);
		}
		expect(rules({ ...copyOnlySite, rootDir: "../other" })).toEqual([
			"node_modules/",
		]);
	});

	// Render reads staticPublishPath only for a static site, so no build
	// makes that directory for a web service.
	it("gives no rule for a web service", () => {
		expect(rules({ ...templateApi, staticPublishPath: "dist" })).toEqual([
			"node_modules/",
		]);
	});

	it("does not change when the manifest lists services in a new order", () => {
		const docs = { ...templateWeb, name: "docs", rootDir: "docs" };
		expect(appGitignore({ services: [templateWeb, docs, templateWeb] })).toBe(
			appGitignore({ services: [docs, templateWeb] }),
		);
	});
});

/**
 * Git decides what a pattern matches, so these tests use real git and a real
 * shell in temporary directories. Nothing here uses the network.
 */
describe("what a commit holds, under real git", () => {
	const PAGE = "<!doctype html><title>Silent retreat</title>";
	const temporary: string[] = [];

	afterEach(() => {
		for (const dir of temporary.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-test-")));
		temporary.push(dir);
		return dir;
	}

	/**
	 * A new repository, isolated from this machine. A git hook that runs the
	 * tests sets GIT_DIR and GIT_INDEX_FILE, which would send these commands
	 * to the outer repository. HOME and XDG_CONFIG_HOME point into the new
	 * one, so a global excludes file cannot change the result.
	 */
	function repository() {
		const root = tempDir();
		const env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
			),
			HOME: root,
			XDG_CONFIG_HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
		};
		const run = (command: string, cwd = root) =>
			execSync(command, { cwd, env, encoding: "utf8" });
		run("git init -q");
		// Runs the command that the workflow sends to the sandbox on this machine.
		const sandbox = {
			mustRun: async (command: string) => run(command),
		} as unknown as Sandbox;
		return { root, run, sandbox };
	}

	function write(dir: string, files: Record<string, string>): void {
		for (const [path, contents] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), contents);
		}
	}

	/** Every file below a directory, relative to it. */
	function filesIn(dir: string): string[] {
		return readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
			.sort();
	}

	const lines = (output: string) => output.split("\n").filter(Boolean).sort();

	it("commits the source of a copy-only site, and its build still works", () => {
		const { root, run } = repository();
		const app = join(root, "apps/demo/retreat");
		// As the builder leaves it: source and photographs, and the output and
		// dependencies of its own builds.
		write(app, {
			".gitignore": appGitignore({ services: [copyOnlySite] }),
			"index.html": PAGE,
			"style.css": "body { margin: 0; }",
			"assets/fog.jpg": "jpeg",
			"dist/index.html": PAGE,
			"dist/assets/fog.jpg": "jpeg",
			"node_modules/serve/index.js": "js",
		});

		run("git add -A");
		expect(lines(run("git ls-files", app))).toEqual([
			".gitignore",
			"assets/fog.jpg",
			"index.html",
			"style.css",
		]);

		// Render: a clone with only what the commit holds, then buildCommand.
		const clone = tempDir();
		run(`git checkout-index -a --prefix=${shellEscape(`${clone}/`)}`);
		const site = join(clone, "apps/demo/retreat");
		run(copyOnlySite.buildCommand, site);
		expect(filesIn(join(site, "dist"))).toEqual([
			"assets/fog.jpg",
			"index.html",
			"style.css",
		]);
		expect(readFileSync(join(site, "dist/index.html"), "utf8")).toBe(PAGE);
	});

	it("removes only what a commit leaves out, and only in one app", async () => {
		const { root, run, sandbox } = repository();
		const app = join(root, "apps/demo/shop");
		write(app, {
			".gitignore": appGitignore({ services: [templateWeb, templateApi] }),
			"assets/chair.jpg": "jpeg",
			"web/src/main.tsx": "source",
			// Source with the same name as the output of the build.
			"web/src/dist/format.ts": "source",
			"web/dist/index.html": PAGE,
			"web/node_modules/vite/index.js": "js",
			// The manifest does not name the output of the API, so it stays.
			"api/dist/index.js": "js",
			"api/node_modules/pg/index.js": "js",
		});
		const other = join(root, "apps/demo/other");
		write(other, {
			".gitignore": appGitignore({ services: [copyOnlySite] }),
			"dist/index.html": PAGE,
		});

		await removeIgnored(sandbox, app);

		const kept = [
			".gitignore",
			"api/dist/index.js",
			"assets/chair.jpg",
			"web/src/dist/format.ts",
			"web/src/main.tsx",
		];
		expect(filesIn(app)).toEqual(kept);
		// So verification builds from the files that a commit takes.
		expect(
			lines(run("git ls-files --cached --others --exclude-standard", app)),
		).toEqual(kept);
		expect(filesIn(other)).toEqual([".gitignore", "dist/index.html"]);
	});
});

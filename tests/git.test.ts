import { execSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Service } from "../app/contracts.js";
import {
	type AppFile,
	type AppFiles,
	appFiles,
	appGitignore,
	cloneAppsRepo,
	commitPaths,
	MAX_APP_BYTES,
	pushVerified,
	REPO_DIR,
	readAppFiles,
	removeIgnored,
	writeAppFiles,
} from "../app/git.js";
import { type ExecResult, type Sandbox, shellEscape } from "../app/sandbox.js";

const OK: ExecResult = { output: "", exitCode: 0 };
const HEAD = "a".repeat(40);
/** What each commit of the shop app may change. */
const PATHS = ["apps/demo/shop", "render.yaml"];

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
const isChangedPaths = (command: string) => command.includes(" diff-tree ");

/** The answer to the list of the paths that a commit changes. */
function changes(...paths: string[]): ExecResult {
	return { output: paths.map((path) => `${path}\0`).join(""), exitCode: 0 };
}

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
	pushVerified(
		sandbox,
		"token",
		"https://github.com/o/r.git",
		"main",
		PATHS,
		resolve,
	);

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
		// The rebase already staged the rest of the commit.
		expect(commands).toContain(
			`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} add -- 'render.yaml'`,
		);
		expect(commands.some((c) => c.includes(" add -A"))).toBe(false);
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

/**
 * A push of the factory is for one app. It must not change the files of
 * another app, and the root Blueprint is the only file outside the app that
 * it changes. The builder once changed apps/<other-user>/ in the clone, and
 * the push took those changes to GitHub.
 */
describe("pushVerified paths", () => {
	it("pushes a commit that changes the app directory and the root Blueprint", async () => {
		const { sandbox, commands } = fakeSandbox((command) =>
			isChangedPaths(command)
				? changes(
						"apps/demo/shop/factory.json",
						"apps/demo/shop/web/index.html",
						"render.yaml",
					)
				: verified(command),
		);

		await expect(push(sandbox)).resolves.toBe(HEAD);
		expect(commands.filter(isPush)).toHaveLength(1);
	});

	it.each([
		"apps/victim/site/index.html",
		"apps/victim/site/factory.json",
		// These share a prefix with an allowed path.
		"apps/demo/shopx/index.html",
		"render.yaml.bak",
		"apps/demo/factory.json",
		"README.md",
	])("sends nothing when the commit also changes %s", async (other) => {
		const { sandbox, commands } = fakeSandbox((command) =>
			isChangedPaths(command)
				? changes("apps/demo/shop/index.html", other)
				: verified(command),
		);

		await expect(push(sandbox)).rejects.toThrow(
			`The commit changes paths outside apps/demo/shop and render.yaml, so it was not pushed: ${other}`,
		);
		expect(commands.some(isPush)).toBe(false);
	});

	// Without the NULs, "apps/demo/shop/a.html" and "apps/victim/site/b.html"
	// join into one path that starts with the app directory.
	it("sends nothing when the list of paths has no NUL terminators", async () => {
		const { sandbox, commands } = fakeSandbox((command) =>
			isChangedPaths(command)
				? {
						output: "apps/demo/shop/a.htmlapps/victim/site/b.html",
						exitCode: 0,
					}
				: verified(command),
		);

		await expect(push(sandbox)).rejects.toThrow(/has no NUL terminators/);
		expect(commands.some(isPush)).toBe(false);
	});

	it("lists the changes of the commit at HEAD, also of a first or a merge commit", async () => {
		const { sandbox, commands } = fakeSandbox((command) =>
			isChangedPaths(command) ? changes("render.yaml") : verified(command),
		);

		await push(sandbox);

		expect(commands.find(isChangedPaths)).toBe(
			`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} diff-tree -m -r -z --root --no-renames --no-commit-id --name-only HEAD`,
		);
	});

	// A rebase makes the commit again on the new tip.
	it("checks the commit again after a rebase", async () => {
		let rebased = false;
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isChangedPaths(command)) {
				return rebased
					? changes("render.yaml", "apps/victim/site/index.html")
					: changes("render.yaml");
			}
			if (isPull(command)) {
				rebased = true;
				return OK;
			}
			if (isPush(command)) return { output: "non-fast-forward", exitCode: 1 };
			return verified(command);
		});

		await expect(push(sandbox)).rejects.toThrow(
			/so it was not pushed: apps\/victim\/site\/index\.html/,
		);
		expect(commands.filter(isPush)).toHaveLength(1);
	});
});

describe("cloneAppsRepo", () => {
	// A link that an earlier commit put in the repository could send a write
	// of the factory out of the clone, for example to put a different git on
	// the PATH before the push.
	it("checks out a symbolic link as a plain file", async () => {
		const { sandbox, commands } = fakeSandbox(() => undefined);

		await cloneAppsRepo(sandbox, "token", { owner: "o", repo: "r" }, "main");

		expect(commands.find((command) => / 'clone' /.test(command))).toContain(
			"'clone' '--depth=1' '--config' 'core.symlinks=false' 'https://github.com/o/r.git' '/home/user/repo'",
		);
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
			// The tar of macOS adds a ._ file for the metadata of each file.
			COPYFILE_DISABLE: "1",
		};
		const run = (command: string, cwd = root) =>
			execSync(command, { cwd, env, encoding: "utf8" });
		run("git init -q");
		run("git config user.name test && git config user.email test@example.com");
		return { root, run, sandbox: localSandbox(root, run) };
	}

	/**
	 * Runs the commands that the workflow sends to the sandbox on this
	 * machine. The clone is at REPO_DIR in the sandbox, and in `root` here.
	 */
	function localSandbox(
		root: string,
		run: (command: string) => string,
	): Sandbox {
		const exec = async (command: string): Promise<ExecResult> => {
			try {
				return { output: run(command.replaceAll(REPO_DIR, root)), exitCode: 0 };
			} catch (error) {
				const failed = error as { status?: number; stdout?: string; stderr?: string };
				return {
					output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
					exitCode: failed.status ?? 1,
				};
			}
		};
		return {
			run: exec,
			async mustRun(command: string, label: string): Promise<string> {
				const result = await exec(command);
				if (result.exitCode !== 0) {
					throw new Error(`${label} failed: ${result.output}`);
				}
				return result.output;
			},
			download: async (path: string) => readFileSync(path),
			upload: async (path: string, data: string | Buffer) =>
				writeFileSync(path, data),
		} as unknown as Sandbox;
	}

	function write(dir: string, files: Record<string, string | Buffer>): void {
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

	/* ── commitPaths ─────────────────────────────────────────────────── */

	/** A clone whose last commit holds two apps and the root Blueprint. */
	function clone() {
		const repo = repository();
		write(repo.root, {
			"apps/demo/shop/index.html": PAGE,
			"apps/victim/site/index.html": PAGE,
			"apps/victim/site/factory.json": "{}",
			"render.yaml": "services: []\n",
			"README.md": "# Apps\n",
		});
		repo.run("git add -A && git commit -q -m base");
		return repo;
	}

	const committed = (run: (command: string) => string) =>
		lines(run("git show --name-only --format= HEAD"));

	// The builder once changed the files of other users in the clone, and
	// the commit took those changes.
	it("commits the app directory and the root Blueprint, and nothing else", async () => {
		const { root, run, sandbox } = clone();
		write(root, {
			"apps/demo/shop/index.html": "<!doctype html><title>Shop</title>",
			"apps/demo/shop/api/index.ts": "export {};",
			"render.yaml": "projects: []\n",
			"apps/victim/site/index.html": "defaced",
			"apps/victim/site/extra.html": "planted",
			"README.md": "# Changed\n",
		});

		await expect(commitPaths(sandbox, "demo/shop", PATHS)).resolves.toMatch(
			/^[0-9a-f]{40}$/,
		);

		expect(committed(run)).toEqual([
			"apps/demo/shop/api/index.ts",
			"apps/demo/shop/index.html",
			"render.yaml",
		]);
		expect(
			lines(run("git status --porcelain --untracked-files=all")),
		).toEqual([
			" M README.md",
			" M apps/victim/site/index.html",
			"?? apps/victim/site/extra.html",
		]);
	});

	it("makes no commit when only paths outside the app changed", async () => {
		const { root, run, sandbox } = clone();
		write(root, { "apps/victim/site/index.html": "defaced" });
		const base = run("git rev-parse HEAD");

		await expect(commitPaths(sandbox, "demo/shop", PATHS)).resolves.toBeNull();
		expect(run("git rev-parse HEAD")).toBe(base);
	});

	// A new attempt of a delete finds the removal that an earlier attempt
	// pushed. git add fails for a path that matches no file.
	it("commits the removal of the app directory, and then finds nothing to commit", async () => {
		const { root, run, sandbox } = clone();
		rmSync(join(root, "apps/demo/shop"), { recursive: true });

		await expect(
			commitPaths(sandbox, "Delete demo/shop", PATHS),
		).resolves.toMatch(/^[0-9a-f]{40}$/);
		expect(lines(run("git show --name-status --format= HEAD"))).toEqual([
			"D\tapps/demo/shop/index.html",
		]);

		await expect(
			commitPaths(sandbox, "Delete demo/shop", PATHS),
		).resolves.toBeNull();
	});

	it("makes the first commit of a new apps repository", async () => {
		const { root, run, sandbox } = repository();
		write(root, {
			"apps/demo/shop/index.html": PAGE,
			"render.yaml": "projects: []\n",
			"notes.txt": "not part of the app",
		});

		await expect(commitPaths(sandbox, "demo/shop", PATHS)).resolves.toMatch(
			/^[0-9a-f]{40}$/,
		);
		expect(committed(run)).toEqual([
			"apps/demo/shop/index.html",
			"render.yaml",
		]);
	});

	/* ── readAppFiles and writeAppFiles ───────────────────────────────── */

	/** Every byte value, as a photograph can hold them. */
	const PHOTO = Buffer.from([...Array(256).keys()]);

	function filesOf(read: AppFiles): AppFile[] {
		if ("error" in read) throw new Error(read.error);
		return read.files;
	}

	it("packs the files that a commit of the app holds, and only those", async () => {
		const { root, run, sandbox } = repository();
		const app = join(root, "apps/demo/shop");
		write(app, {
			".gitignore": appGitignore({ services: [templateWeb, templateApi] }),
			"web/src/main.tsx": "source",
			"web/dist/index.html": PAGE,
			"web/node_modules/vite/index.js": "js",
			"api/src/index.ts": "api",
			"assets/chair.jpg": PHOTO,
			"build.sh": "#!/bin/sh\necho built\n",
		});
		chmodSync(join(app, "build.sh"), 0o755);
		// The builder can write outside its app directory in its sandbox.
		write(root, { "apps/victim/site/index.html": "defaced" });
		// The builder is told not to run git. A file that it staged is still
		// part of the app.
		run("git add apps/demo/shop/api/src/index.ts");

		const files = filesOf(await readAppFiles(sandbox, app));

		expect(files.map(({ path }) => path).sort()).toEqual([
			".gitignore",
			"api/src/index.ts",
			"assets/chair.jpg",
			"build.sh",
			"web/src/main.tsx",
		]);
		expect(files.find(({ path }) => path === "assets/chair.jpg")?.data).toEqual(
			PHOTO,
		);
		expect(
			files.filter(({ executable }) => executable).map(({ path }) => path),
		).toEqual(["build.sh"]);
	});

	it("refuses a symbolic link", async () => {
		const { root, sandbox } = repository();
		const app = join(root, "apps/demo/shop");
		write(app, { "index.html": PAGE });
		symlinkSync("index.html", join(app, "home.html"));

		await expect(readAppFiles(sandbox, app)).resolves.toEqual({
			error: expect.stringContaining("home.html is a symbolic link."),
		});
	});

	// Without the .git directory, the commit holds its files.
	it("refuses a Git repository in the app, which git lists as one directory", async () => {
		const { root, run, sandbox } = repository();
		const app = join(root, "apps/demo/shop");
		write(app, { "web/index.html": PAGE });
		run("git init -q", join(app, "web"));

		await expect(readAppFiles(sandbox, app)).resolves.toEqual({
			error: expect.stringContaining(
				"web is a Git repository in the app directory. Remove web/.git",
			),
		});
	});

	it("writes the files of the app into a clone, in place of the old ones", async () => {
		const { root, sandbox } = repository();
		const app = join(root, "apps/demo/shop");
		write(app, { "old.html": "from an earlier run" });
		const files: AppFile[] = [
			{ path: "index.html", data: Buffer.from(PAGE), executable: false },
			{ path: "assets/chair.jpg", data: PHOTO, executable: false },
			{ path: "web/src/it's here.ts", data: Buffer.from("x"), executable: false },
			{ path: "-rf", data: Buffer.from("a name like an option"), executable: false },
			{ path: "empty.txt", data: Buffer.alloc(0), executable: false },
			{ path: "bin/build.sh", data: Buffer.from("#!/bin/sh\n"), executable: true },
		];

		await writeAppFiles(sandbox, app, files);

		expect(filesIn(app)).toEqual(files.map(({ path }) => path).sort());
		for (const { path, data } of files) {
			expect(readFileSync(join(app, path)), path).toEqual(data);
		}
		expect(statSync(join(app, "bin/build.sh")).mode & 0o111).toBe(0o111);
		expect(statSync(join(app, "index.html")).mode & 0o111).toBe(0);
	});

	// What the sandbox of the build packs is what the clone commits.
	it("copies an app from one repository into another", async () => {
		const build = repository();
		const app = join(build.root, "apps/demo/shop");
		write(app, {
			".gitignore": appGitignore({ services: [copyOnlySite] }),
			"index.html": PAGE,
			"assets/fog.jpg": PHOTO,
			"dist/index.html": PAGE,
		});
		const target = clone();

		await writeAppFiles(
			target.sandbox,
			join(target.root, "apps/demo/shop"),
			filesOf(await readAppFiles(build.sandbox, app)),
		);
		await commitPaths(target.sandbox, "demo/shop", PATHS);

		expect(
			lines(target.run("git ls-files -- apps/demo/shop")),
		).toEqual([
			"apps/demo/shop/.gitignore",
			"apps/demo/shop/assets/fog.jpg",
			"apps/demo/shop/index.html",
		]);
		expect(
			readFileSync(join(target.root, "apps/demo/shop/assets/fog.jpg")),
		).toEqual(PHOTO);
	});
});

describe("readAppFiles", () => {
	/** A sandbox that answers the pack command, and then each rm. */
	function packing(result: ExecResult) {
		const download = vi.fn();
		const run = vi.fn(async () => OK).mockResolvedValueOnce(result);
		return { sandbox: { run, download } as unknown as Sandbox, download };
	}

	it("stops an archive over the limit before the download", async () => {
		const { sandbox, download } = packing({
			output: `${MAX_APP_BYTES + 1}\n`,
			exitCode: 0,
		});

		await expect(
			readAppFiles(sandbox, "/home/user/repo/apps/demo/shop"),
		).resolves.toEqual({
			error: expect.stringContaining("the limit is 50 MB"),
		});
		expect(download).not.toHaveBeenCalled();
	});

	// A problem of the files is for the builder to fix, so it is a result.
	it("gives the output of a pack that fails", async () => {
		const { sandbox, download } = packing({
			output: "tar: web/server.log: file changed as we read it\n",
			exitCode: 1,
		});

		await expect(
			readAppFiles(sandbox, "/home/user/repo/apps/demo/shop"),
		).resolves.toEqual({
			error:
				"The files of the app could not be packed: tar: web/server.log: file changed as we read it\n",
		});
		expect(download).not.toHaveBeenCalled();
	});
});

/**
 * A tar archive with entries that tar does not make from the app directory.
 * The builder controls its sandbox, so it can put any archive there.
 */
function tarOf(
	entries: {
		path: string;
		type?: HeaderData["type"];
		data?: string;
		mode?: number;
		linkpath?: string;
	}[],
): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		new Header({
			path: entry.path,
			type: entry.type ?? "File",
			mode: entry.mode ?? 0o644,
			size: data.length,
			mtime: new Date(0),
			linkpath: entry.linkpath,
		}).encode(header, 0);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("appFiles", () => {
	it("reads the regular files of an archive, with the executable bit", async () => {
		await expect(
			appFiles(
				tarOf([
					{ path: "index.html", data: "<p>Shop</p>" },
					{ path: "bin/build.sh", data: "#!/bin/sh\n", mode: 0o755 },
				]),
			),
		).resolves.toEqual({
			files: [
				{ path: "index.html", data: Buffer.from("<p>Shop</p>"), executable: false },
				{ path: "bin/build.sh", data: Buffer.from("#!/bin/sh\n"), executable: true },
			],
		});
	});

	// Each of these would write outside the app directory, or into git.
	it.each([
		["/etc/cron.d/job", "is not a plain path below the app directory"],
		["../victim/site/index.html", "is not a plain path below the app directory"],
		["web/../../victim/site/index.html", "is not a plain path below the app directory"],
		["./index.html", "is not a plain path below the app directory"],
		["web//index.html", "is not a plain path below the app directory"],
		[".git/config", "is in a .git directory"],
		["web/.GIT/hooks/post-checkout", "is in a .git directory"],
		["index\n.html", "has a control character in its name"],
	])("refuses the path %j", async (path, reason) => {
		await expect(appFiles(tarOf([{ path, data: "x" }]))).resolves.toEqual({
			error: expect.stringContaining(reason),
		});
	});

	it.each<[HeaderData["type"], string | undefined, string]>([
		["SymbolicLink", "/usr/local/bin/git", "home.html is a symbolic link."],
		["Link", "index.html", "home.html is a Link entry."],
		["FIFO", undefined, "home.html is a FIFO entry."],
		["CharacterDevice", undefined, "home.html is a CharacterDevice entry."],
		["Directory", undefined, "home.html is a Git repository"],
	])("refuses a %s entry", async (type, linkpath, reason) => {
		await expect(
			appFiles(tarOf([{ path: "home.html", type, linkpath }])),
		).resolves.toEqual({ error: expect.stringContaining(reason) });
	});

	it("refuses a path that is in the archive two times", async () => {
		await expect(
			appFiles(
				tarOf([
					{ path: "index.html", data: "first" },
					{ path: "index.html", data: "second" },
				]),
			),
		).resolves.toEqual({
			error: "index.html is in the archive two times.",
		});
	});

	// readAppFiles() packs a plain tar. Compressed data can expand in memory
	// to much more than the limit.
	it("refuses a compressed archive", async () => {
		await expect(
			appFiles(gzipSync(tarOf([{ path: "index.html", data: "x" }]))),
		).resolves.toEqual({ error: "The archive of the app is compressed." });
	});

	it("refuses data that is not a tar archive", async () => {
		await expect(appFiles(Buffer.from("not an archive"))).resolves.toEqual({
			error: expect.stringContaining("is not a valid tar archive"),
		});
	});

	it("refuses an archive over the limit", async () => {
		await expect(appFiles(Buffer.alloc(MAX_APP_BYTES + 1))).resolves.toEqual({
			error: expect.stringContaining("the limit is 50 MB"),
		});
	});
});

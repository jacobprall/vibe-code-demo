import { describe, expect, it, vi } from "vitest";
import type { ExecResult, Sandbox } from "../app/sandbox.js";
import {
	assetCollect,
	assetFetch,
	bestCandidate,
	type CommonsCandidate,
	commonsQueries,
	sandboxApplyPatch,
	sandboxExec,
	sandboxListDir,
	sandboxReadFile,
	sandboxSearch,
	sandboxWriteFile,
	type ToolContext,
} from "../app/tools.js";

const APP_DIR = "/home/user/repo/apps/demo/shop";

function context(sandbox: Partial<Sandbox>, workDir = APP_DIR): ToolContext {
	return { sandbox: sandbox as Sandbox, workDir };
}

type RunFn = (
	command: string,
	opts?: { signal?: AbortSignal },
) => Promise<ExecResult>;

/** Typed so assertions can read back the command that was run. */
const runMock = (output: string, exitCode = 0) =>
	vi.fn<RunFn>(async () => ({ output, exitCode }));

describe("sandbox__exec", () => {
	it("returns command output on success", async () => {
		const run = runMock("all tests passed");
		const out = await sandboxExec.invoke(
			{ command: "npm test" },
			context({ run }),
		);

		expect(out.content).toBe("all tests passed");
		expect(out.isError).toBe(false);
	});

	/**
	 * The exec API starts in `/`. A run once built an entire application from
	 * relative paths, landing it in `/root` — outside the checkout, so the
	 * commit found nothing and no stage reported a failure.
	 */
	it("runs from the app directory when given no cwd", async () => {
		const run = runMock("");
		await sandboxExec.invoke({ command: "mkdir -p web" }, context({ run }));

		expect(run.mock.calls[0][0]).toBe(
			"cd '/home/user/repo/apps/demo/shop' && mkdir -p web",
		);
	});

	it("resolves a relative cwd against the app directory", async () => {
		const run = runMock("");
		await sandboxExec.invoke(
			{ command: "npm ci", cwd: "api" },
			context({ run }),
		);

		expect(run.mock.calls[0][0]).toBe(
			"cd '/home/user/repo/apps/demo/shop/api' && npm ci",
		);
	});

	it.each(["/root", "/home/user/repo/../../etc", "../../../../../../root"])(
		"refuses to run in %s",
		async (cwd) => {
			const run = runMock("");
			const out = await sandboxExec.invoke(
				{ command: "npm ci", cwd },
				context({ run }),
			);

			expect(out.isError).toBe(true);
			expect(out.content).toContain("outside the checkout");
			expect(run).not.toHaveBeenCalled();
		},
	);

	it("reports a non-zero exit as a tool error with its exit code", async () => {
		const run = runMock("1 failing", 1);
		const out = await sandboxExec.invoke(
			{ command: "npm test" },
			context({ run }),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("Exit code: 1");
		expect(out.content).toContain("1 failing");
	});

	it("runs inside an absolute cwd inside the checkout", async () => {
		const run = runMock("");
		await sandboxExec.invoke(
			{ command: "ls", cwd: "/home/user/repo/apps/demo/shop/web" },
			context({ run }),
		);

		expect(run.mock.calls[0][0]).toBe(
			"cd '/home/user/repo/apps/demo/shop/web' && ls",
		);
	});
});

describe("sandbox file tools", () => {
	it("reads a file", async () => {
		const readFile = vi.fn(async () => "export const x = 1;");
		const out = await sandboxReadFile.invoke(
			{ path: "src/x.ts" },
			context({ readFile }),
		);

		expect(readFile).toHaveBeenCalledWith(`${APP_DIR}/src/x.ts`);
		expect(out.content).toBe("export const x = 1;");
	});

	it("writes relative paths into the app directory", async () => {
		const writeFile = vi.fn(async () => undefined);
		const out = await sandboxWriteFile.invoke(
			{ path: "src/x.ts", content: "hello" },
			context({ writeFile }),
		);

		expect(writeFile).toHaveBeenCalledWith(`${APP_DIR}/src/x.ts`, "hello");
		expect(out.content).toContain("Wrote 5 bytes");
	});

	it("refuses to write outside the checkout", async () => {
		const writeFile = vi.fn(async () => undefined);
		const out = await sandboxWriteFile.invoke(
			{ path: "/root/index.html", content: "hello" },
			context({ writeFile }),
		);

		expect(out.isError).toBe(true);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("defaults list_dir to the app directory", async () => {
		const listDir = vi.fn(async () => ["a.ts", "b/"]);
		const out = await sandboxListDir.invoke({}, context({ listDir }));

		expect(listDir).toHaveBeenCalledWith(APP_DIR);
		expect(out.content).toBe("a.ts\nb/");
	});

	it("describes an empty directory rather than returning nothing", async () => {
		const listDir = vi.fn(async () => []);
		const out = await sandboxListDir.invoke(
			{ path: "empty" },
			context({ listDir }),
		);
		expect(out.content).toBe("(empty directory)");
	});
});

describe("sandbox__search", () => {
	it("treats ripgrep exit 1 as no matches, not a failure", async () => {
		const run = runMock("", 1);
		const out = await sandboxSearch.invoke(
			{ pattern: "nope" },
			context({ run }),
		);

		expect(out.content).toBe("(no matches)");
		expect(out.isError).toBeUndefined();
	});

	it("reports a real ripgrep failure as an error", async () => {
		const run = runMock("bad pattern", 2);
		const out = await sandboxSearch.invoke({ pattern: "[" }, context({ run }));
		expect(out.isError).toBe(true);
	});

	it("passes an include glob through to ripgrep", async () => {
		const run = runMock("src/x.ts:1:hit");
		await sandboxSearch.invoke(
			{ pattern: "hit", include: "*.ts" },
			context({ run }),
		);

		expect(run.mock.calls[0][0]).toContain("'--glob' '*.ts'");
	});
});

describe("sandbox__apply_patch", () => {
	it("uploads the diff and applies it", async () => {
		const upload = vi.fn(async () => undefined);
		const run = runMock("");
		const out = await sandboxApplyPatch.invoke(
			{ diff: "--- a\n+++ b\n" },
			context({ upload, run }),
		);

		expect(upload).toHaveBeenCalledOnce();
		expect(run.mock.calls[0][0]).toContain("git apply --whitespace=nowarn");
		expect(out.content).toBe("Patch applied successfully.");
	});

	it("surfaces a rejected patch as an error", async () => {
		const out = await sandboxApplyPatch.invoke(
			{ diff: "garbage" },
			context({
				upload: vi.fn(async () => undefined),
				run: runMock("does not apply", 1),
			}),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("does not apply");
	});
});

/**
 * These two guard the write path from the internet into the checkout. A
 * mismatch here once made the whole curator stage a silent no-op: every
 * download was rejected and the run still reported success.
 */
describe("asset__fetch destinations", () => {
	const noWrite = () => context({ writeFile: vi.fn(async () => undefined) });

	it.each([
		"/home/user/repo/apps/demo/shop/assets/chair.jpg",
		"/home/user/repo/apps/demo/shop/web/public/assets/chair.png",
		"/home/user/repo/apps/demo/shop/static/assets/chair.webp",
	])("accepts %s", async (path) => {
		const out = await assetFetch.invoke(
			{ url: "https://upload.wikimedia.org/a.jpg", path },
			noWrite(),
		);
		// Rejected destinations fail before any network call; these get past it.
		expect(out.content).not.toContain("Destination must be");
	});

	it("accepts a path relative to the app directory", async () => {
		const out = await assetFetch.invoke(
			{ url: "https://upload.wikimedia.org/a.jpg", path: "assets/chair.jpg" },
			noWrite(),
		);
		expect(out.content).not.toContain("Destination must be");
	});

	it.each([
		["/etc/cron.d/payload.jpg", "inside the checkout"],
		["/home/user/repo/render.yaml", "assets/"],
		["/home/user/repo/apps/demo/shop/assets/script.js", "assets/"],
		["/home/user/repo/apps/demo/shop/images/chair.jpg", "assets/"],
	])("rejects %s", async (path, because) => {
		const out = await assetFetch.invoke(
			{ url: "https://upload.wikimedia.org/a.jpg", path },
			noWrite(),
		);
		expect(out.isError).toBe(true);
		expect(out.content).toContain(because);
	});
});

/**
 * Commons requires every term to match, so a five-word subject finds nothing
 * and the curator burns its turn budget re-searching by hand.
 */
describe("commonsQueries", () => {
	it("shortens a prose subject, longest first", () => {
		expect(commonsQueries("Beneteau Oceanis sailboat sailing offshore")).toEqual(
			[
				"Beneteau Oceanis sailboat sailing offshore",
				"beneteau oceanis sailboat sailing offshore",
				"beneteau oceanis sailboat sailing",
				"beneteau oceanis sailboat",
				"beneteau oceanis",
			],
		);
	});

	it("drops words Commons gains nothing from matching", () => {
		expect(commonsQueries("sailboat cockpit and wheel helm closeup")).toContain(
			"sailboat cockpit wheel helm",
		);
	});

	it("leaves an already short subject as a single search", () => {
		expect(commonsQueries("walnut chair")).toEqual(["walnut chair"]);
	});

	it("survives punctuation and empty input", () => {
		expect(commonsQueries("  ")).toEqual([]);
		expect(commonsQueries("Hallberg-Rassy cruising sailboat!")).toContain(
			"hallberg-rassy cruising sailboat",
		);
	});
});

/**
 * Real candidates for "pocket gopher". Every thumbnail comes back at the
 * requested box, so thumbnail size says nothing about quality — sorting by it
 * picked the tallest image, which was a 1.8 MB portrait, and shipped it into a
 * landing page.
 */
describe("bestCandidate", () => {
	const candidate = (
		title: string,
		sourceWidth: number,
		sourceHeight: number,
	): CommonsCandidate => ({
		title,
		url: `https://upload.wikimedia.org/${title}.jpg`,
		width: 1200,
		height: sourceWidth >= sourceHeight ? 900 : 1200,
		sourceWidth,
		sourceHeight,
		credit: "someone / Wikimedia Commons (CC BY-SA 4.0)",
	});

	it("prefers a large landscape source over a taller one", () => {
		const pick = bestCandidate([
			candidate("portrait", 1151, 2048),
			candidate("mounds", 4000, 3000),
			candidate("closeup", 2048, 1536),
		]);
		expect(pick?.title).toBe("mounds");
	});

	it("skips a source too small to fill the thumbnail it would be upscaled to", () => {
		const pick = bestCandidate([
			candidate("tiny-but-wide", 450, 326),
			candidate("real", 2048, 1536),
		]);
		expect(pick?.title).toBe("real");
	});

	it("takes a portrait when no landscape source qualifies", () => {
		expect(bestCandidate([candidate("portrait", 1568, 1735)])?.title).toBe(
			"portrait",
		);
	});

	it("falls back to a small source rather than returning nothing", () => {
		expect(bestCandidate([candidate("tiny", 450, 326)])?.title).toBe("tiny");
	});

	it("has nothing to pick from an empty list", () => {
		expect(bestCandidate([])).toBeUndefined();
	});
});

describe("asset__collect", () => {
	const ctx = () => context({ writeFile: vi.fn(async () => undefined) });

	it("rejects a destDir outside the checkout", async () => {
		const out = await assetCollect.invoke(
			{ subjects: ["walnut chair"], destDir: "/tmp/assets" },
			ctx(),
		);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("inside the checkout");
	});

	it("rejects a destDir that is not an assets directory", async () => {
		const out = await assetCollect.invoke(
			{ subjects: ["walnut chair"], destDir: "/home/user/repo/apps/demo/shop" },
			ctx(),
		);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("/assets");
	});
});

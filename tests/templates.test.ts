/**
 * The template is only worth having if it stays true. These assertions pin the
 * three ways it can rot without anything else noticing: files going missing,
 * the extraction script mangling them on the way into the sandbox, and the
 * template drifting away from the manifest the builder is told to return.
 */
import { describe, expect, it } from "vitest";
import { extractionScript, readTemplate } from "../app/templates.js";

const files = await readTemplate("fullstack");
const byPath = new Map(files.map((file) => [file.path, file.contents]));

function json(path: string): Record<string, never> {
	const contents = byPath.get(path);
	if (!contents) throw new Error(`${path} is missing from the template`);
	return JSON.parse(contents);
}

describe("readTemplate", () => {
	it("reads both tiers", () => {
		expect(byPath.has("web/src/App.tsx")).toBe(true);
		expect(byPath.has("api/src/index.ts")).toBe(true);
		expect(byPath.has("api/sql/schema.sql")).toBe(true);
		expect(byPath.has("api/sql/seed.sql")).toBe(true);
	});

	// The builder is told to run `npm ci`, which fails outright without one.
	it("ships a lockfile for each tier", () => {
		expect(byPath.has("web/package-lock.json")).toBe(true);
		expect(byPath.has("api/package-lock.json")).toBe(true);
	});

	// Anyone who builds a template locally leaves artifacts behind, and they
	// would otherwise ship into every generated app.
	it("leaves out what the sandbox installs or builds", () => {
		const leaked = files
			.map((file) => file.path)
			.filter(
				(path) =>
					path.includes("node_modules") ||
					path.includes("/dist/") ||
					path.endsWith(".tsbuildinfo"),
			);
		expect(leaked).toEqual([]);
	});
});

describe("the manifest the builder is told to return", () => {
	it("matches the scripts the template actually defines", () => {
		expect(json("web/package.json").scripts).toMatchObject({
			build: expect.stringContaining("vite build"),
		});
		expect(json("api/package.json").scripts).toMatchObject({
			build: expect.any(String),
			migrate: expect.any(String),
			start: expect.any(String),
		});
	});

	it("serves the health and data endpoints the manifest names", () => {
		const api = byPath.get("api/src/index.ts") ?? "";
		expect(api).toContain('"/health"');
		expect(api).toContain('"/api/items"');
	});

	// The storefront and the API are different onrender.com origins, so without
	// this every browser request fails while every server-side check passes.
	it("enables CORS on the API", () => {
		expect(byPath.get("api/src/index.ts")).toContain("cors()");
	});

	// fromService gives a bare hostname, and an unset variable would otherwise
	// be baked in as "undefined" by a build that passes.
	it("builds the API base URL from a hostname, with a fallback", () => {
		const api = byPath.get("web/src/lib/api.ts") ?? "";
		expect(api).toContain("VITE_API_HOST");
		expect(api).toMatch(/https:\/\/\$\{host\}/);
		expect(api).toMatch(/host \?.*:.*http/s);
	});

	// preDeployCommand runs on every deploy, including redeploys of an
	// unchanged commit.
	it("has an idempotent schema and a non-empty seed", () => {
		expect(byPath.get("api/sql/schema.sql")).toMatch(/create table if not exists/i);
		expect(byPath.get("api/sql/seed.sql")).toMatch(/on conflict/i);
		expect(byPath.get("api/sql/seed.sql")).toMatch(/insert into/i);
	});
});

describe("extractionScript", () => {
	const script = extractionScript(files, "/home/user/repo/apps/demo/shop");

	it("creates nested directories before writing into them", () => {
		expect(script).toContain("cd '/home/user/repo/apps/demo/shop'");
		expect(script).toMatch(/^mkdir -p .*'api\/sql'/m);
		expect(script).toMatch(/^mkdir -p .*'web\/src\/components\/ui'/m);
	});

	it("writes every file exactly once", () => {
		for (const file of files) {
			expect(script).toContain(`cat > '${file.path}' <<'FACTORY_TEMPLATE_EOF'`);
		}
		expect(script.match(/^cat > /gm)).toHaveLength(files.length);
	});

	// An unquoted heredoc would let the shell expand ${...} and $( ) in JSX and
	// SQL on the way in.
	it("quotes every heredoc so nothing is expanded", () => {
		expect(script.match(/<<'FACTORY_TEMPLATE_EOF'/g)).toHaveLength(files.length);
		expect(script).not.toMatch(/<<FACTORY_TEMPLATE_EOF/);
	});

	it("refuses a file that would end its own heredoc", () => {
		expect(() =>
			extractionScript(
				[{ path: "a.txt", contents: "before\nFACTORY_TEMPLATE_EOF\nrm -rf /" }],
				"/tmp/x",
			),
		).toThrow(/heredoc delimiter/);
	});
});

/**
 * The Blueprint is the factory's only write path to Render, so what it emits
 * is the thing most worth pinning down. Blueprints are now generated from the
 * agent-declared service manifest.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	appBlueprint,
	resourceNames,
	rootBlueprint,
} from "../app/blueprint.js";
import type { AppSpec, Manifest, Service } from "../app/contracts.js";

const fullManifest: Manifest = {
	services: [
		{
			name: "api",
			kind: "web_service",
			rootDir: "api",
			runtime: "node",
			buildCommand: "npm install",
			startCommand: "npm start",
			preDeployCommand: "npm run migrate",
			healthCheckPath: "/health",
			dataCheckPath: "/api/products",
			envVars: [
				{
					key: "DATABASE_URL",
					fromDatabase: { property: "connectionString" },
				},
			],
		},
		{
			name: "web",
			kind: "static_site",
			rootDir: "web",
			runtime: "static",
			buildCommand: "npm install && npm run build",
			staticPublishPath: "./dist",
			envVars: [
				{
					key: "VITE_API_HOST",
					fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
				},
			],
		},
	],
	databases: [{ name: "main-db" }],
};

const staticOnlyManifest: Manifest = {
	services: [
		{
			name: "site",
			kind: "static_site",
			rootDir: "site",
			runtime: "static",
			buildCommand: "npm install && npm run build",
			staticPublishPath: "./dist",
		},
	],
};

const apiOnlyManifest: Manifest = {
	services: [
		{
			name: "api",
			kind: "web_service",
			rootDir: ".",
			runtime: "node",
			buildCommand: "npm install",
			startCommand: "npm start",
			healthCheckPath: "/health",
		},
	],
};

/** The manifest allows six services and three databases; naming has to keep up. */
const multiServiceManifest: Manifest = {
	services: [
		...fullManifest.services,
		{
			name: "Search Service",
			kind: "web_service",
			rootDir: "search",
			runtime: "node",
			buildCommand: "npm install",
			startCommand: "npm start",
			healthCheckPath: "/health",
		},
	],
	databases: [{ name: "main-db" }, { name: "analytics" }],
};

function spec(overrides: Partial<AppSpec> = {}): AppSpec {
	return {
		user: "demo",
		appName: "furniture-catalog",
		prompt: "Create an online catalog to sell handcrafted furniture",
		summary: "A storefront, an API, and Postgres behind it.",
		createdAt: "2026-01-01T00:00:00.000Z",
		resourcePrefix: "vibe",
		tiers: ["static_site", "web_service", "postgres"],
		manifest: fullManifest,
		notes: [],
		...overrides,
	};
}

/** The full app, with some fields of its API and its storefront replaced. */
function withServices(
	api: Partial<Service>,
	web: Partial<Service> = {},
): AppSpec {
	const [apiService, webService] = fullManifest.services;
	return spec({
		manifest: {
			...fullManifest,
			services: [
				{ ...apiService, ...api },
				{ ...webService, ...web },
			],
		},
	});
}

/** The services of the first app in a Blueprint, after a YAML parse. */
function parsedServices(yaml: string) {
	return parse(yaml).projects[0].environments[0].services;
}

describe("resourceNames", () => {
	it("preserves the prefix used by specs created before the rename", () => {
		const names = resourceNames(spec({ resourcePrefix: undefined }));
		expect(names.web).toBe("airo-demo-furniture-catalog-web");
	});

	it("namespaces every resource by user and app", () => {
		const names = resourceNames(spec());
		expect(names.web).toBe("vibe-demo-furniture-catalog-web");
		expect(names.api).toBe("vibe-demo-furniture-catalog-api");
		expect(names.db).toBe("vibe-demo-furniture-catalog-db");
	});

	it("omits resources the app does not have", () => {
		const names = resourceNames(
			spec({ tiers: ["static_site"], manifest: staticOnlyManifest }),
		);
		expect(names.api).toBeNull();
		expect(names.db).toBeNull();
	});

	it("has no storefront when the app is only an API", () => {
		const names = resourceNames(spec({ manifest: apiOnlyManifest }));
		expect(names.web).toBeNull();
		expect(names.api).toBe("vibe-demo-furniture-catalog-api");
	});

	// Two resources collapsing onto one name overwrites one of them in the
	// Blueprint rather than failing, so this is the check that matters.
	it("gives every service and database a distinct name", () => {
		const names = resourceNames(spec({ manifest: multiServiceManifest }));
		const all = [...names.services.values(), ...names.databases.values()];
		expect(new Set(all).size).toBe(all.length);
	});

	it("keeps the primary names and names the rest after themselves", () => {
		const names = resourceNames(spec({ manifest: multiServiceManifest }));
		expect(names.services.get("api")).toBe("vibe-demo-furniture-catalog-api");
		expect(names.services.get("web")).toBe("vibe-demo-furniture-catalog-web");
		expect(names.services.get("Search Service")).toBe(
			"vibe-demo-furniture-catalog-search-service",
		);
		expect(names.databases.get("main-db")).toBe(
			"vibe-demo-furniture-catalog-db",
		);
		expect(names.databases.get("analytics")).toBe(
			"vibe-demo-furniture-catalog-analytics",
		);
	});
});

describe("appBlueprint", () => {
	const yaml = appBlueprint(spec());

	it("puts the app in its own project with one environment", () => {
		expect(yaml.match(/^projects:$/gm)).toHaveLength(1);
		expect(yaml).toMatch(/^ {2}- name: vibe-demo-furniture-catalog$/m);
		expect(yaml).toMatch(/^ {6}- name: production$/m);
		expect(yaml).toMatch(/^ {8}services:$/m);
		expect(yaml).not.toMatch(/^(services|databases):/m);
	});

	it("scopes both services to the app's directory", () => {
		expect(yaml).toContain('rootDir: "apps/demo/furniture-catalog/api"');
		expect(yaml).toContain('rootDir: "apps/demo/furniture-catalog/web"');
	});

	it("uses commands from the manifest", () => {
		expect(yaml).toContain('buildCommand: "npm install && npm run build"');
		expect(yaml).toContain('startCommand: "npm start"');
		expect(yaml).toContain('healthCheckPath: "/health"');
	});

	it("declares the storefront as a static site", () => {
		expect(yaml).toContain("runtime: static");
		expect(yaml).toContain('staticPublishPath: "./dist"');
	});

	it("wires the database into the API and the API into the storefront", () => {
		expect(yaml).toContain("fromDatabase:");
		expect(yaml).toContain('property: "connectionString"');
		expect(yaml).toContain('key: "VITE_API_HOST"');
	});

	// `property: host` is a name on the private network. A static site is not
	// on that network, and only a browser uses the value.
	it("gives the storefront the public hostname of the API", () => {
		expect(yaml).toContain(
			[
				'              - key: "VITE_API_HOST"',
				"                fromService:",
				"                  name: vibe-demo-furniture-catalog-api",
				"                  type: web",
				'                  envVarKey: "RENDER_EXTERNAL_HOSTNAME"',
			].join("\n"),
		);
		expect(yaml).not.toContain('property: "host"');
	});

	it("keeps a property reference for wiring on the private network", () => {
		const search: Manifest["services"][number] = {
			name: "search",
			kind: "web_service",
			rootDir: "search",
			runtime: "node",
			buildCommand: "npm install",
			startCommand: "npm start",
			envVars: [
				{
					key: "API_HOSTPORT",
					fromService: { name: "api", property: "hostport" },
				},
			],
		};
		const wired = appBlueprint(
			spec({
				manifest: {
					...fullManifest,
					services: [...fullManifest.services, search],
				},
			}),
		);
		expect(wired).toContain(
			[
				'              - key: "API_HOSTPORT"',
				"                fromService:",
				"                  name: vibe-demo-furniture-catalog-api",
				"                  type: web",
				'                  property: "hostport"',
			].join("\n"),
		);
	});

	it("declares the database in the app's environment", () => {
		expect(yaml).toMatch(/^ {8}databases:$/m);
		expect(yaml).toContain("name: vibe-demo-furniture-catalog-db");
	});

	// Without this the schema is never applied and the app deploys against an
	// empty database, which no other check would notice.
	it("emits the pre-deploy command that creates the schema", () => {
		expect(yaml).toContain('preDeployCommand: "npm run migrate"');
		expect(yaml.indexOf("preDeployCommand:")).toBeLessThan(
			yaml.indexOf("startCommand:"),
		);
	});

	it("emits one block per service and per database", () => {
		const multi = appBlueprint(spec({ manifest: multiServiceManifest }));
		expect(multi).toContain("name: vibe-demo-furniture-catalog-search-service");
		expect(multi).toContain("name: vibe-demo-furniture-catalog-analytics");
		expect(multi.match(/^ {10}- type: web$/gm)).toHaveLength(3);
	});

	it("emits only a static site when that is all the app needs", () => {
		const simple = appBlueprint(
			spec({ tiers: ["static_site"], manifest: staticOnlyManifest }),
		);
		expect(simple).not.toContain("databases:");
		expect(simple).not.toContain("runtime: node");
		expect(simple).toContain("runtime: static");
	});

	// A comment stops at a line break. YAML 1.1 parsers also read NEL as a line
	// break, and they do not accept control characters.
	it("keeps the prompt comment on one line", () => {
		const text = appBlueprint(
			spec({ prompt: "Sell\u{7}\u{7f} chairs\u{85}services: []" }),
		);
		expect(text.split("\n")[1]).toBe("# Prompt: Sell chairs services: []");
	});
});

describe("rootBlueprint", () => {
	it("is valid with no apps yet, so the Blueprint can be created first", () => {
		expect(rootBlueprint([])).toContain("services: []");
	});

	const twoApps = rootBlueprint([
		spec(),
		spec({
			user: "demo",
			appName: "gopher-dates",
			tiers: ["static_site"],
			manifest: staticOnlyManifest,
		}),
	]);

	it("holds every app, each in its own project", () => {
		expect(twoApps.match(/^projects:$/gm)).toHaveLength(1);
		expect(twoApps.match(/^ {2}- name: /gm)).toHaveLength(2);
		expect(twoApps).toMatch(/^ {2}- name: vibe-demo-furniture-catalog$/m);
		expect(twoApps).toMatch(/^ {2}- name: vibe-demo-gopher-dates$/m);
		expect(twoApps).toContain("vibe-demo-furniture-catalog-web");
		expect(twoApps).toContain("vibe-demo-gopher-dates-web");
		expect(twoApps).not.toMatch(/^(services|databases):/m);
	});

	// A database declared under another app's project would move it there.
	it("keeps each database in its own app's project", () => {
		expect(twoApps.match(/^ {8}databases:$/gm)).toHaveLength(1);
		const database = twoApps.indexOf("name: vibe-demo-furniture-catalog-db");
		expect(database).toBeGreaterThan(
			twoApps.indexOf("- name: vibe-demo-furniture-catalog\n"),
		);
		expect(database).toBeLessThan(
			twoApps.indexOf("- name: vibe-demo-gopher-dates\n"),
		);
	});

	it("orders apps deterministically so a rerun does not churn the file", () => {
		const a = spec({ user: "alice", appName: "aaa" });
		const b = spec({ user: "bob", appName: "bbb" });
		expect(rootBlueprint([a, b])).toBe(rootBlueprint([b, a]));
	});
});

// The builder writes the manifest values, and one value that breaks the YAML
// stops the deploy of every app in the root Blueprint.
describe("manifest values", () => {
	// Without quotes, the first command stops the parse, the second loses the
	// text after `#`, and the third becomes a boolean.
	it("keeps commands that contain YAML syntax exactly as written", () => {
		const [api, web] = parsedServices(
			rootBlueprint([
				withServices(
					{
						buildCommand: 'npm ci && echo "build: done"',
						startCommand: "node server.js # Render sets PORT",
					},
					{ buildCommand: "true" },
				),
			]),
		);
		expect(api.buildCommand).toBe('npm ci && echo "build: done"');
		expect(api.startCommand).toBe("node server.js # Render sets PORT");
		expect(web.buildCommand).toBe("true");
	});

	// JSON keeps these characters raw and gives a lone surrogate a `\udXXX`
	// escape. go-yaml stops the parse of the full file at each of them. The
	// parser in this test accepts them all, so the test also checks the text.
	it("escapes the characters that YAML 1.1 parsers do not accept", () => {
		const raw =
			"\u{7f}\u{80}\u{9f} \u{85}--- \u{2028}--- \u{2029}... \u{fffe}\u{ffff}";
		const yaml = rootBlueprint([
			withServices({
				buildCommand: `echo ${raw}${String.fromCharCode(0xd800)}`,
			}),
		]);
		expect(yaml).not.toMatch(
			/[\u{7f}-\u{9f}\u{2028}\u{2029}\u{fffe}\u{ffff}]|\\ud[89a-f]/iu,
		);
		expect(parsedServices(yaml)[0].buildCommand).toBe(`echo ${raw}\u{fffd}`);
	});
});

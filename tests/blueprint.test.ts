/**
 * The Blueprint is the factory's only write path to Render, so what it emits
 * is the thing most worth pinning down. Blueprints are now generated from the
 * agent-declared service manifest.
 */
import { describe, expect, it } from "vitest";
import {
	appBlueprint,
	resourceNames,
	rootBlueprint,
} from "../app/blueprint.js";
import type { AppSpec, Manifest } from "../app/contracts.js";

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
					fromService: { name: "api", property: "host" },
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
		tiers: ["static_site", "web_service", "postgres"],
		manifest: fullManifest,
		notes: [],
		...overrides,
	};
}

describe("resourceNames", () => {
	it("namespaces every resource by user and app", () => {
		const names = resourceNames(spec());
		expect(names.web).toBe("airo-demo-furniture-catalog-web");
		expect(names.api).toBe("airo-demo-furniture-catalog-api");
		expect(names.db).toBe("airo-demo-furniture-catalog-db");
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
		expect(names.api).toBe("airo-demo-furniture-catalog-api");
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
		expect(names.services.get("api")).toBe("airo-demo-furniture-catalog-api");
		expect(names.services.get("web")).toBe("airo-demo-furniture-catalog-web");
		expect(names.services.get("Search Service")).toBe(
			"airo-demo-furniture-catalog-search-service",
		);
		expect(names.databases.get("main-db")).toBe(
			"airo-demo-furniture-catalog-db",
		);
		expect(names.databases.get("analytics")).toBe(
			"airo-demo-furniture-catalog-analytics",
		);
	});
});

describe("appBlueprint", () => {
	const yaml = appBlueprint(spec());

	it("scopes both services to the app's directory", () => {
		expect(yaml).toContain("rootDir: apps/demo/furniture-catalog/api");
		expect(yaml).toContain("rootDir: apps/demo/furniture-catalog/web");
	});

	it("uses commands from the manifest", () => {
		expect(yaml).toContain("buildCommand: npm install && npm run build");
		expect(yaml).toContain("startCommand: npm start");
		expect(yaml).toContain("healthCheckPath: /health");
	});

	it("declares the storefront as a static site", () => {
		expect(yaml).toContain("runtime: static");
		expect(yaml).toContain("staticPublishPath: ./dist");
	});

	it("wires the database into the API and the API into the storefront", () => {
		expect(yaml).toContain("fromDatabase:");
		expect(yaml).toContain("property: connectionString");
		expect(yaml).toContain("key: VITE_API_HOST");
		expect(yaml).toContain("property: host");
	});

	it("declares the database", () => {
		expect(yaml).toContain("databases:");
		expect(yaml).toContain("name: airo-demo-furniture-catalog-db");
	});

	// Without this the schema is never applied and the app deploys against an
	// empty database, which no other check would notice.
	it("emits the pre-deploy command that creates the schema", () => {
		expect(yaml).toContain("preDeployCommand: npm run migrate");
		expect(yaml.indexOf("preDeployCommand:")).toBeLessThan(
			yaml.indexOf("startCommand:"),
		);
	});

	it("emits one block per service and per database", () => {
		const multi = appBlueprint(spec({ manifest: multiServiceManifest }));
		expect(multi).toContain("name: airo-demo-furniture-catalog-search-service");
		expect(multi).toContain("name: airo-demo-furniture-catalog-analytics");
		expect(multi.match(/^ {2}- type: web$/gm)).toHaveLength(3);
	});

	it("emits only a static site when that is all the app needs", () => {
		const simple = appBlueprint(
			spec({ tiers: ["static_site"], manifest: staticOnlyManifest }),
		);
		expect(simple).not.toContain("databases:");
		expect(simple).not.toContain("runtime: node");
		expect(simple).toContain("runtime: static");
	});
});

describe("rootBlueprint", () => {
	it("is valid with no apps yet, so the Blueprint can be created first", () => {
		expect(rootBlueprint([])).toContain("services: []");
	});

	it("holds every app, with one databases block", () => {
		const yaml = rootBlueprint([
			spec(),
			spec({
				user: "godaddy",
				appName: "gopher-dates",
				tiers: ["static_site"],
				manifest: staticOnlyManifest,
			}),
		]);

		expect(yaml).toContain("airo-demo-furniture-catalog-web");
		expect(yaml).toContain("airo-godaddy-gopher-dates-web");
		expect(yaml.match(/^databases:$/gm)).toHaveLength(1);
		expect(yaml.match(/^services:$/gm)).toHaveLength(1);
	});

	it("orders apps deterministically so a rerun does not churn the file", () => {
		const a = spec({ user: "alice", appName: "aaa" });
		const b = spec({ user: "bob", appName: "bbb" });
		expect(rootBlueprint([a, b])).toBe(rootBlueprint([b, a]));
	});
});

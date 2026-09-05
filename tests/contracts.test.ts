import { describe, expect, it } from "vitest";
import { parseModelJson } from "../app/claude.js";
import {
	appSpecSchema,
	assetManifestSchema,
	createAppRequestSchema,
	deployPlanSchema,
	manifestSchema,
	workflowInputSchema,
} from "../app/contracts.js";

const plan = {
	appName: "furniture-catalog",
	summary: "A storefront, an API, and Postgres behind it.",
	tiers: [{ kind: "static_site", reason: "the storefront" }],
	assetQueries: ["handcrafted walnut dining chair"],
	brief: {
		pages: ["Home"],
		features: [],
		voice: "warm",
		content: "Real copy.",
		dataModel: "products(name, price_cents)",
	},
};

describe("parseModelJson", () => {
	it("parses a bare JSON object", () => {
		expect(parseModelJson(deployPlanSchema, JSON.stringify(plan))?.appName).toBe(
			"furniture-catalog",
		);
	});

	it("parses JSON inside a fenced code block", () => {
		const raw = `Here you go:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
		expect(parseModelJson(deployPlanSchema, raw)?.tiers).toHaveLength(1);
	});

	it("parses JSON surrounded by prose", () => {
		const raw = `Sure. ${JSON.stringify(plan)} Hope that helps.`;
		expect(parseModelJson(deployPlanSchema, raw)?.summary).toContain("Postgres");
	});

	it("returns null rather than throwing on unparseable output", () => {
		expect(parseModelJson(deployPlanSchema, "I could not decide.")).toBeNull();
	});

	it("returns null when JSON is valid but violates the schema", () => {
		expect(
			parseModelJson(deployPlanSchema, JSON.stringify({ ...plan, tiers: [] })),
		).toBeNull();
	});
});

describe("createAppRequestSchema", () => {
	it("defaults the user namespace", () => {
		const parsed = createAppRequestSchema.parse({
			prompt: "Create an online catalog to sell handcrafted furniture",
		});
		expect(parsed.user).toBe("demo");
	});

	it("rejects a prompt that is too short or too long", () => {
		expect(createAppRequestSchema.safeParse({ prompt: "hi" }).success).toBe(false);
		expect(
			createAppRequestSchema.safeParse({ prompt: "x".repeat(2001) }).success,
		).toBe(false);
	});

	// The user becomes a directory name and part of a Render resource name.
	it("rejects a user that is not a slug", () => {
		for (const user of ["../etc", "Demo User", "a", "x".repeat(40)]) {
			expect(
				createAppRequestSchema.safeParse({ prompt: "a valid prompt", user })
					.success,
			).toBe(false);
		}
	});
});

describe("deployPlanSchema", () => {
	it("rejects an appName that is not a slug", () => {
		for (const appName of ["Furniture Catalog", "../escape", "no"]) {
			expect(deployPlanSchema.safeParse({ ...plan, appName }).success).toBe(
				false,
			);
		}
	});

	it("rejects a tier it does not recognize", () => {
		expect(
			deployPlanSchema.safeParse({
				...plan,
				tiers: [{ kind: "kubernetes", reason: "no" }],
			}).success,
		).toBe(false);
	});
});

describe("assetManifestSchema", () => {
	const asset = {
		path: "assets/walnut-chair.jpg",
		subject: "walnut chair",
		alt: "A walnut dining chair",
		credit: "Someone / Wikimedia Commons (CC BY-SA 4.0)",
	};

	it("accepts an image inside the assets directory", () => {
		expect(assetManifestSchema.safeParse({ assets: [asset] }).success).toBe(true);
	});

	// The manifest path is written into the app, so it cannot wander.
	it.each([
		"../../../etc/passwd",
		"/etc/passwd",
		"assets/../../secret.jpg",
		"assets/script.js",
	])("rejects the path %s", (path) => {
		expect(
			assetManifestSchema.safeParse({ assets: [{ ...asset, path }] }).success,
		).toBe(false);
	});
});

describe("workflowInputSchema", () => {
	it("requires a prompt, a user, and a run id", () => {
		expect(
			workflowInputSchema.safeParse({ prompt: "a valid prompt", runId: "r" })
				.success,
		).toBe(false);
		expect(
			workflowInputSchema.safeParse({
				prompt: "a valid prompt",
				user: "demo",
				runId: "r",
			}).success,
		).toBe(true);
	});
});

const validManifest = {
	services: [
		{
			name: "web",
			kind: "static_site",
			rootDir: "web",
			runtime: "static",
			buildCommand: "npm install && npm run build",
			staticPublishPath: "./dist",
		},
	],
};

describe("manifestSchema", () => {
	it("accepts a minimal static site manifest", () => {
		expect(manifestSchema.safeParse(validManifest).success).toBe(true);
	});

	it("accepts a full-stack manifest with databases", () => {
		const manifest = {
			services: [
				{
					name: "api",
					kind: "web_service",
					rootDir: "api",
					runtime: "node",
					buildCommand: "npm install",
					startCommand: "npm start",
					healthCheckPath: "/health",
					envVars: [
						{
							key: "DATABASE_URL",
							fromDatabase: { property: "connectionString" },
						},
					],
				},
				...validManifest.services,
			],
			databases: [{ name: "main-db" }],
		};
		expect(manifestSchema.safeParse(manifest).success).toBe(true);
	});

	it("carries the database lifecycle a full-stack app needs", () => {
		const parsed = manifestSchema.parse({
			services: [
				{
					name: "api",
					kind: "web_service",
					rootDir: "api",
					runtime: "node",
					buildCommand: "npm install",
					startCommand: "npm start",
					preDeployCommand: "npm run migrate && npm run seed",
					healthCheckPath: "/health",
					dataCheckPath: "/api/products",
					envVars: [
						{
							key: "DATABASE_URL",
							fromDatabase: { property: "connectionString", name: "main-db" },
						},
					],
				},
			],
			databases: [{ name: "main-db" }],
		});
		expect(parsed.services[0].preDeployCommand).toBe(
			"npm run migrate && npm run seed",
		);
		expect(parsed.services[0].dataCheckPath).toBe("/api/products");
		expect(parsed.services[0].envVars?.[0].fromDatabase?.name).toBe("main-db");
	});

	it("rejects an empty services array", () => {
		expect(manifestSchema.safeParse({ services: [] }).success).toBe(false);
	});

	it("rejects an unknown service kind", () => {
		expect(
			manifestSchema.safeParse({
				services: [{ ...validManifest.services[0], kind: "lambda" }],
			}).success,
		).toBe(false);
	});
});

describe("appSpecSchema", () => {
	it("round-trips the spec committed beside a generated app", () => {
		const spec = {
			user: "demo",
			appName: "furniture-catalog",
			prompt: "Create an online catalog to sell handcrafted furniture",
			summary: "A catalog.",
			createdAt: new Date().toISOString(),
			tiers: ["static_site"],
			manifest: validManifest,
			notes: [],
		};
		expect(appSpecSchema.parse(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
	});
});

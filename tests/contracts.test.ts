import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentJson } from "../app/claude.js";
import {
	appSpecSchema,
	buildOutputSchema,
	createAppRequestSchema,
	deleteAppInputSchema,
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

/**
 * The SDK checks the output of an agent against its JSON Schema. Zod checks
 * it again, because a JSON Schema cannot hold each Zod rule.
 */
describe("agentJson", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the output when it matches the schema", async () => {
		const call = vi.fn(async () => plan);

		const result = await agentJson(call, deployPlanSchema, "Design it.", "architect");

		expect(result.appName).toBe("furniture-catalog");
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("gives the Zod error back to the agent one time", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({ ...plan, tiers: [] })
			.mockResolvedValueOnce(plan);

		await expect(
			agentJson(call, deployPlanSchema, "Design it.", "architect"),
		).resolves.toMatchObject({ appName: "furniture-catalog" });
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[1][0]).toMatch(/^Design it\.\n/);
		expect(call.mock.calls[1][0]).toContain("at tiers");
	});

	// The text of an agent without a schema is not an object, so it cannot match.
	it("stops after a second output that does not match", async () => {
		const call = vi.fn(async () => "I could not decide.");

		await expect(
			agentJson(call, deployPlanSchema, "Design it.", "architect"),
		).rejects.toThrow("architect returned invalid structured output twice");
		expect(call).toHaveBeenCalledTimes(2);
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

	// Render takes one or the other. With neither, the Blueprint would get
	// `property: undefined`.
	it("requires exactly one of property and envVarKey on fromService", () => {
		const accepts = (fromService: Record<string, string>) =>
			manifestSchema.safeParse({
				services: [
					{
						...validManifest.services[0],
						envVars: [{ key: "VITE_API_HOST", fromService }],
					},
				],
			}).success;

		expect(
			accepts({ name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" }),
		).toBe(true);
		expect(accepts({ name: "api", property: "hostport" })).toBe(true);
		expect(accepts({ name: "api" })).toBe(false);
		expect(
			accepts({
				name: "api",
				property: "host",
				envVarKey: "RENDER_EXTERNAL_HOSTNAME",
			}),
		).toBe(false);
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

describe("deleteAppInputSchema", () => {
	it("names an app with two slugs, because they become a path in the repository", () => {
		expect(
			deleteAppInputSchema.safeParse({ user: "demo", appName: "shop" }).success,
		).toBe(true);
		expect(
			deleteAppInputSchema.safeParse({ user: "demo", appName: "../shop" })
				.success,
		).toBe(false);
		expect(deleteAppInputSchema.safeParse({ user: "demo" }).success).toBe(
			false,
		);
	});
});

describe("appSpecSchema", () => {
	const spec = {
		user: "demo",
		appName: "furniture-catalog",
		prompt: "Create an online catalog to sell handcrafted furniture",
		summary: "A catalog.",
		createdAt: "2026-01-01T00:00:00.000Z",
		resourcePrefix: "vibe",
		manifest: validManifest,
	};

	it("keeps deletedAt, which takes an app out of the root Blueprint", () => {
		const deleting = { ...spec, deletedAt: "2026-02-01T00:00:00.000Z" };
		expect(appSpecSchema.parse(deleting).deletedAt).toBe(deleting.deletedAt);
	});

	it("round-trips the spec committed beside a generated app", () => {
		expect(appSpecSchema.parse(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
	});

	// The resource names come from the prefix in the spec, never from a default.
	it("requires resourcePrefix", () => {
		const { resourcePrefix: _, ...unprefixed } = spec;
		expect(appSpecSchema.safeParse(unprefixed).success).toBe(false);
	});

	// Earlier specs in the apps repository also hold tiers and notes.
	it("reads a spec with fields that the factory no longer writes", () => {
		expect(
			appSpecSchema.parse({ ...spec, tiers: ["static_site"], notes: [] }),
		).toEqual(spec);
	});
});

describe("buildOutputSchema", () => {
	it("keeps the user-facing build summary concise", () => {
		expect(
			buildOutputSchema.safeParse({
				summary: "x".repeat(241),
				manifest: validManifest,
			}).success,
		).toBe(false);
	});
});

/** Zod schemas for external input, agent output, and the stored spec. */
import { z } from "zod";

const slug = z
	.string()
	.regex(/^[a-z][a-z0-9-]{2,30}$/, "must be a lowercase slug");

/* ── Public API ───────────────────────────────────────────────────────── */

export const createAppRequestSchema = z.object({
	prompt: z.string().trim().min(8).max(2000),
	/** Namespace the generated app is filed under in the apps repository. */
	user: slug.default("demo"),
	/** Supply one to make a retried curl safe; omit it and every call is a run. */
	idempotencyKey: z
		.string()
		.trim()
		.min(8)
		.max(200)
		.regex(/^[A-Za-z0-9._:-]+$/)
		.optional(),
});

export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;

/* ── Workflow input ───────────────────────────────────────────────────── */

export const workflowInputSchema = z.object({
	prompt: z.string().trim().min(8).max(2000),
	user: slug,
	runId: z.string().min(1).max(300),
});

export type WorkflowInput = z.infer<typeof workflowInputSchema>;

/** Every run of one app shares its files and resources, so a delete names the app. */
export const deleteAppInputSchema = z.object({
	user: slug,
	appName: slug,
});

export type DeleteAppInput = z.infer<typeof deleteAppInputSchema>;

/** The input of the step of a delete that waits for the syncs of the apps Blueprint. */
export const waitForSyncsInputSchema = deleteAppInputSchema.extend({
	/**
	 * When the delete pushed the commit that took the app out of the
	 * Blueprint, or null if an earlier attempt pushed it.
	 */
	pushedAt: z.number().int().nonnegative().nullable(),
});

export type WaitForSyncsInput = z.infer<typeof waitForSyncsInputSchema>;

/* ── Architect ────────────────────────────────────────────────────────── */

/**
 * The Render primitives the architect may ask for. app/blueprint.ts emits
 * each one from the manifest. AGENTS.md tells how to add a primitive.
 */
export const TIER_KINDS = ["static_site", "web_service", "postgres"] as const;

export const deployPlanSchema = z.object({
	appName: slug,
	summary: z.string().min(1).max(2000),
	tiers: z
		.array(
			z.object({
				kind: z.enum(TIER_KINDS),
				reason: z.string().min(1).max(500),
			}),
		)
		.min(1)
		.max(4),
	/**
	 * The subjects that the workflow finds photographs of, one each. Capped
	 * low on purpose — each subject is a Commons round trip, and a landing
	 * page needs a few good photographs, not a gallery.
	 */
	assetQueries: z.array(z.string().min(3).max(120)).max(4).optional().default([]),
	brief: z.object({
		pages: z.array(z.string().min(1).max(120)).min(1).max(8),
		features: z.array(z.string().min(1).max(200)).max(12),
		voice: z.string().min(1).max(500),
		content: z.string().min(1).max(4000),
		/** Entities, fields, and seed data the API and database should hold. */
		dataModel: z.string().max(3000).optional().default(""),
	}),
});

export type DeployPlan = z.infer<typeof deployPlanSchema>;

/* ── Service manifest ──────────────────────────────────────────────────── */

/**
 * The builder declares what it built. Each service becomes a Blueprint entry
 * and drives the verification the workflow runs before pushing.
 */
export const serviceSchema = z.object({
	name: z.string().min(1).max(60),
	kind: z.enum(["static_site", "web_service"]),
	/** Directory relative to the app root, e.g. "web" or "api". */
	rootDir: z.string().min(1).max(120),
	runtime: z.enum(["node", "static"]).default("node"),
	buildCommand: z.string().min(1).max(500),
	startCommand: z.string().max(500).optional(),
	/**
	 * Migrations and seeds. Render runs it after the build and before the start
	 * command, with the service's env vars already wired, so it is the only
	 * place a generated app can create its schema. Must be idempotent: it runs
	 * on every deploy, including redeploys of an unchanged commit.
	 */
	preDeployCommand: z.string().max(500).optional(),
	staticPublishPath: z.string().max(120).optional(),
	healthCheckPath: z.string().max(120).optional(),
	/**
	 * An endpoint that reads the database. `healthCheckPath` deliberately does
	 * not, so without this nothing — locally or in production — ever proves the
	 * schema was applied, the seed loaded, or `DATABASE_URL` was wired.
	 */
	dataCheckPath: z.string().max(120).optional(),
	envVars: z
		.array(
			z.object({
				key: z.string().min(1).max(60),
				/** `name` selects among several databases; omit it for the only one. */
				fromDatabase: z
					.object({ property: z.string(), name: z.string().optional() })
					.optional(),
				/**
				 * Render accepts one `property`, such as `host`, or one `envVarKey`,
				 * such as `RENDER_EXTERNAL_HOSTNAME`. `host` is a name on the private
				 * network, and a static site is not on that network.
				 */
				fromService: z
					.object({
						name: z.string(),
						property: z.string().optional(),
						envVarKey: z.string().optional(),
					})
					.refine(
						(ref) =>
							(ref.property === undefined) !== (ref.envVarKey === undefined),
						"set exactly one of property and envVarKey",
					)
					.optional(),
			}),
		)
		.max(10)
		.optional(),
});

export type Service = z.infer<typeof serviceSchema>;

export const manifestSchema = z.object({
	services: z.array(serviceSchema).min(1).max(6),
	databases: z
		.array(z.object({ name: z.string().min(1).max(60) }))
		.max(3)
		.optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;

/* ── Builder ──────────────────────────────────────────────────────────── */

export const buildOutputSchema = z.object({
	summary: z.string().min(1).max(240),
	manifest: manifestSchema,
});

export type BuildOutput = z.infer<typeof buildOutputSchema>;

/* ── Deploy manager ───────────────────────────────────────────────────── */

export const deployFailureSchema = z.object({
	serviceName: z.string().min(1).max(120),
	status: z.string().min(1).max(60),
	diagnosis: z.string().min(1).max(4000),
	logs: z.string().max(8000).optional(),
});

export const deployDiagnosisSchema = z.object({
	allHealthy: z.boolean(),
	failures: z.array(deployFailureSchema).max(10),
});

export type DeployDiagnosis = z.infer<typeof deployDiagnosisSchema>;

/* ── The stored app spec ──────────────────────────────────────────────── */

/**
 * `factory.json`, committed beside each generated app. It is the machine-readable
 * source for both the app's own render.yaml and the repository-root Blueprint,
 * which is why the root Blueprint can be regenerated without parsing YAML.
 */
export const appSpecSchema = z.object({
	user: slug,
	appName: slug,
	prompt: z.string().min(1),
	summary: z.string().min(1),
	createdAt: z.string().min(1),
	/** Persisted so changing the default never renames an existing app's resources. */
	resourcePrefix: slug,
	manifest: manifestSchema,
	/**
	 * Set when a delete of the app starts. The root Blueprint leaves the app
	 * out, and this file stays until the app's Render resources are gone,
	 * because a retry of the delete reads it to find them.
	 */
	deletedAt: z.string().min(1).optional(),
});

export type AppSpec = z.infer<typeof appSpecSchema>;

/**
 * The input of the step of a delete that deletes the app's Render resources:
 * only the fields of the spec that name them.
 */
export const deleteResourcesInputSchema = appSpecSchema.pick({
	user: true,
	appName: true,
	resourcePrefix: true,
});

export type DeleteResourcesInput = z.infer<typeof deleteResourcesInputSchema>;

/* ── Verify and publish ───────────────────────────────────────────────── */

/**
 * The input of verify-app. The sandbox holds the builder's files, and
 * workflow code gives its id, never a model. The app directory comes from
 * user and appName, so the input names no path.
 */
export const verifyAppInputSchema = z.object({
	sandboxId: z.string().min(1),
	user: slug,
	appName: slug,
	manifest: manifestSchema,
	/** The Postgres in the sandbox, or null when the app has no database. */
	databaseUrl: z.string().min(1).nullable(),
});

export type VerifyAppInput = z.infer<typeof verifyAppInputSchema>;

/**
 * The input of publish-app. `sandboxId` is the sandbox of the build, which
 * publish-app reads the files of the app from. It pushes from a sandbox of
 * its own. The spec gives factory.json and both Blueprints. The repository
 * and the GitHub token come from the configuration of the workflow, never
 * from the input: the Render Dashboard shows the input of each task run.
 */
export const publishAppInputSchema = z.object({
	sandboxId: z.string().min(1),
	spec: appSpecSchema,
	message: z.string().min(1),
});

export type PublishAppInput = z.infer<typeof publishAppInputSchema>;

/* ── Terminal results ─────────────────────────────────────────────────── */

export type WorkflowResult =
	| {
			status: "deployed";
			user: string;
			appName: string;
			webUrl: string;
			apiUrl: string | null;
			summary: string;
	  }
	| {
			/** Code is committed, but no Blueprint is watching the repository yet. */
			status: "awaiting_blueprint";
			user: string;
			appName: string;
			summary: string;
	  }
	| { status: "build_failed"; summary: string }
	| { status: "deploy_failed"; summary: string }
	/** The run stopped before it built, for a reason that a retry cannot fix. */
	| { status: "failed"; summary: string };

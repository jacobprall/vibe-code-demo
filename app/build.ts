/**
 * The build stage of prompt-to-app: the builder writes the app, and
 * verify-app checks it, for a limited number of rounds. Also the message
 * that the builder starts from.
 */
import type { TaskContext } from "@renderinc/sdk/workflows";
import { buildTask } from "./agents.js";
import { agentJson } from "./claude.js";
import {
	type BuildOutput,
	buildOutputSchema,
	type DeployPlan,
	type Manifest,
} from "./contracts.js";
import type { Image } from "./images.js";
import type { Sandbox } from "./sandbox.js";
import { setRunStage } from "./store.js";
import { verifyAppTask } from "./verify.js";

const MAX_BUILD_ROUNDS = 2;

interface BuildOutcome {
	passed: boolean;
	summary: string;
	manifest: Manifest;
	failures: string;
}

export async function buildAndVerify(opts: {
	tasks: TaskContext;
	sandbox: Sandbox;
	appDir: string;
	user: string;
	plan: DeployPlan;
	prompt: string;
	runId: string;
	images: readonly Image[];
	databaseUrl: string | null;
	template: readonly string[];
}): Promise<BuildOutcome> {
	let buildOutput = await runBuilder(
		opts.tasks,
		opts.sandbox,
		opts.appDir,
		builderMessage(opts),
		"builder",
	);

	for (let round = 0; round <= MAX_BUILD_ROUNDS; round++) {
		await setRunStage(opts.runId, "verifying");
		const { failures } = await opts.tasks.run(verifyAppTask, {
			sandboxId: opts.sandbox.id,
			user: opts.user,
			appName: opts.plan.appName,
			manifest: buildOutput.manifest,
			databaseUrl: opts.databaseUrl,
		});
		if (failures.length === 0) {
			return {
				passed: true,
				summary: buildOutput.summary,
				manifest: buildOutput.manifest,
				failures: "",
			};
		}
		if (round === MAX_BUILD_ROUNDS) {
			return {
				passed: false,
				summary: buildOutput.summary,
				manifest: buildOutput.manifest,
				failures: failures.join("\n\n"),
			};
		}

		await setRunStage(opts.runId, "building");
		buildOutput = await runBuilder(
			opts.tasks,
			opts.sandbox,
			opts.appDir,
			`Verification failed. Fix exactly what this output names:\n\n${failures.join("\n\n")}`,
			`builder-fix-${round + 1}`,
		);
	}

	return {
		passed: false,
		summary: buildOutput.summary,
		manifest: buildOutput.manifest,
		failures: "Verification never completed.",
	};
}

export function runBuilder(
	tasks: TaskContext,
	sandbox: Sandbox,
	appDir: string,
	message: string,
	stage: string,
): Promise<BuildOutput> {
	return agentJson(
		(text) =>
			tasks.run(buildTask, {
				message: text,
				sandboxId: sandbox.id,
				workDir: appDir,
			}),
		buildOutputSchema,
		message,
		stage,
	);
}

function builderMessage(opts: {
	prompt: string;
	plan: DeployPlan;
	appDir: string;
	images: readonly Image[];
	databaseUrl: string | null;
	template: readonly string[];
}): string {
	const { plan } = opts;
	return [
		`Product prompt:\n${opts.prompt}`,
		"",
		`App directory: ${opts.appDir}`,
		opts.template.length > 0
			? "Commands and relative paths already start here; only what is in this directory ships."
			: [
					"Build the entire application from scratch in this directory. Commands and",
					"relative paths already start here; only what is in this directory ships.",
				].join("\n"),
		"",
		`Approved plan:\n${plan.summary}`,
		`Infrastructure: ${plan.tiers.map((t) => `${t.kind} (${t.reason})`).join(", ")}`,
		"",
		`Pages: ${plan.brief.pages.join(", ")}`,
		`Features: ${plan.brief.features.join(", ") || "none specified"}`,
		`Voice: ${plan.brief.voice}`,
		"",
		`Content direction:\n${plan.brief.content}`,
		...(plan.brief.dataModel ? [`Data model:\n${plan.brief.dataModel}`] : []),
		"",
		templateLines(opts.template),
		"",
		databaseLines(opts.databaseUrl),
		"",
		imageLines(opts.images),
	].join("\n");
}

/**
 * The template is a working three-tier app, so the builder's job is to turn it
 * into the product rather than to reinvent the wiring. Spelling out the
 * manifest it corresponds to is the point: those exact values are what
 * verification and the Blueprint are built around.
 */
export function templateLines(template: readonly string[]): string {
	if (template.length === 0) {
		return "Skeleton: none. Choose your own stack and lay the app out yourself.";
	}
	return [
		"A working skeleton is already in the app directory. It builds, serves, and",
		"reads from Postgres as it stands — change it into the product rather than",
		"starting over, and keep the contracts it establishes.",
		"",
		"  web/  Vite + React + TypeScript + Tailwind v4, with shadcn/ui Button and",
		"        Card in src/components/ui and the cn() helper in src/lib/utils.ts.",
		"        src/lib/api.ts already builds the API base URL from VITE_API_HOST.",
		"  api/  Hono + node-postgres. CORS is on, GET /health answers without the",
		"        database, GET /api/items reads it. src/migrate.ts applies",
		"        sql/schema.sql and sql/seed.sql and is wired to npm run migrate.",
		"",
		"Both have a package-lock.json, so build with npm ci, not npm install.",
		"Rename the items table and the /api/items route to suit the product; edit",
		"sql/seed.sql to hold the real catalog from the brief.",
		"",
		"Return this manifest, adjusted only where you actually changed something:",
		"  web: static_site, rootDir web, build `npm ci && npm run build`,",
		"       staticPublishPath dist, envVar VITE_API_HOST fromService api",
		"       envVarKey RENDER_EXTERNAL_HOSTNAME. Do not use property host: a",
		"       browser cannot connect to that private-network name.",
		"  api: web_service, rootDir api, build `npm ci && npm run build`,",
		"       preDeployCommand `npm run migrate`, start `npm start`,",
		"       healthCheckPath /health, dataCheckPath /api/items,",
		"       envVar DATABASE_URL fromDatabase connectionString",
		`Files: ${template.join(", ")}`,
	].join("\n");
}

function databaseLines(databaseUrl: string | null): string {
	if (!databaseUrl) return "Database: none. Do not declare one in the manifest.";
	return [
		`Database: a real Postgres 18 is already running at ${databaseUrl}.`,
		"It is the same database your preDeployCommand and your service will use",
		"during verification, so develop against it — psql is on the PATH.",
		"Declare it in the manifest as a database, wire DATABASE_URL to it with",
		"fromDatabase, and set preDeployCommand and dataCheckPath on the service.",
	].join("\n");
}

/**
 * One line per photograph rather than a pretty-printed list. This text rides
 * along on every builder turn, so keeping it tight is worth it.
 */
function imageLines(images: readonly Image[]): string {
	if (images.length === 0) {
		return "Photographs: none available. Use inline SVG and CSS for all imagery.";
	}
	return [
		"Photographs already in assets/ (path | subject | credit to publish):",
		...images.map(
			(image) => `- ${image.path} | ${image.subject} | ${image.credit}`,
		),
	].join("\n");
}

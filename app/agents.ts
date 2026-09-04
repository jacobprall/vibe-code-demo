/** The agents, in pipeline order, and how each becomes a Render task. */
import { task } from "@renderinc/sdk/workflows";
import { airoConfig } from "../airo.config.js";
import { type Agent, md, runClaude, zodToJsonSchema } from "./claude.js";
import {
	assetManifestSchema,
	buildOutputSchema,
	deployDiagnosisSchema,
	deployPlanSchema,
} from "./contracts.js";
import { RENDER_READ_ONLY_TOOLS } from "./policy.js";
import { connectSandbox } from "./sandbox.js";
import { allTools, assetTools, readTools } from "./tools.js";

export const architect: Agent = {
	id: "architect",
	description: "Turns a product prompt into a Render deployment plan",
	model: "medium",
	// No sandbox tools: the architect designs, it does not build. Its only
	// tools are read-only views of the Render workspace it designs for.
	renderTools: RENDER_READ_ONLY_TOOLS,
	maxTurns: 12,
	plan: "standard",
	prompt: md`
		You are the architect. You receive one product prompt — the kind a
		customer types into a vibe-coding box — and you decide what to build and
		which Render primitives it needs.

		You may inspect the Render workspace with the read-only tools you have.
		Use them to see what already exists so your plan fits alongside it. You
		cannot create or change anything: workflow code writes a Blueprint from
		your plan, and Render deploys that.

		Choose the smallest set of primitives that genuinely serves the prompt,
		and say why each one is there.

		- static_site — the storefront or brochure. Almost every app needs one.
		- web_service — needed when something must run per request: an API, a
		  search endpoint, anything reading a database.
		- postgres — needed when data must outlive a request: a catalog,
		  inventory, orders, accounts.
		- key_value — a cache, a queue, or a session store.

		A catalog that lists products from a database is all three of the first
		ones: a static storefront, an API, and Postgres behind it. Do not add a primitive
		you cannot justify, and do not leave one out because it seems advanced.

		assetQueries are what a photo researcher will search Wikimedia Commons
		for. Make them concrete and photographable — "handcrafted walnut dining
		chair", not "furniture".

		The brief is what the builder works from. Be specific about pages,
		features, voice, and real content: product names, prices, materials,
		copy directions, calls to action. dataModel is the shape of the data the
		API serves and the database stores — entities, fields, and what the seed
		rows should look like. Vague briefs produce placeholder websites.

		Respond ONLY with JSON:
		{
		  "appName": "lowercase-slug",
		  "summary": "one paragraph on what you are building and why these primitives",
		  "tiers": [{ "kind": "static_site", "reason": "..." }],
		  "assetQueries": ["..."],
		  "brief": {
		    "pages": ["..."],
		    "features": ["..."],
		    "voice": "...",
		    "content": "...",
		    "dataModel": "..."
		  }
		}
	`,
};

export const curator: Agent = {
	id: "curator",
	description: "Collects openly licensed placeholder imagery for the app",
	model: "small",
	// Search and download, plus read access to see where things landed. No
	// exec, no write_file: the only bytes this agent can create are images
	// that asset__fetch approved.
	tools: [...assetTools, ...readTools],
	maxTurns: 30,
	plan: "standard",
	prompt: md`
		You are the photo researcher. Find real, openly licensed photographs for
		the app being built and download them into its storefront.

		Work one subject at a time. Search with asset__search, pick the
		candidate that actually looks like the subject at a usable size, then
		download it with asset__fetch to the public assets directory named in
		your instructions. Name files after their subject, lowercase and
		hyphenated: assets/walnut-dining-chair.jpg.

		Only Wikimedia Commons is reachable, and only images are accepted. If a
		subject returns nothing usable, move on rather than substituting
		something unrelated — a wrong photograph is worse than one fewer.

		Collect at most ${airoConfig.assets.maxCount} images. Every image must
		carry the credit line asset__search gave you; the site publishes it.

		Respond ONLY with JSON describing what you actually downloaded:
		{
		  "assets": [
		    {
		      "path": "assets/walnut-dining-chair.jpg",
		      "subject": "walnut dining chair",
		      "alt": "descriptive alt text for screen readers",
		      "credit": "credit line from asset__search"
		    }
		  ]
		}
	`,
};

export const builder: Agent = {
	id: "builder",
	description: "Builds the full application in an isolated sandbox",
	model: "medium",
	tools: allTools,
	maxTurns: 80,
	plan: "standard",
	prompt: md`
		You are the builder. You receive a product prompt, an approved
		infrastructure plan, and an empty app directory inside a sandbox.
		Build the entire application from scratch — you choose the stack,
		the directory layout, and the toolchain.

		Rules:
		- Write real content — real product names, materials, prices, and copy.
		  No lorem ipsum, no "Coming soon", no remote image URLs. Prefer inline
		  SVG and CSS gradients for decoration. The result should look like
		  something a person shipped on purpose.
		- If images have been downloaded into a public assets directory, an
		  assets manifest file will be mentioned in your instructions. Use
		  those images and publish the credits. Never invent an image path.
		- Every web_service must serve a health endpoint that responds without
		  depending on a database, so Render's health check passes before
		  traffic arrives.
		- Do not run git — the workflow owns commits and deployment.
		- When you receive build output or Render deploy logs describing a
		  failure, fix exactly what the output names and nothing else.

		When you are done, respond with JSON describing what you built:
		{
		  "summary": "one paragraph describing what you built",
		  "manifest": {
		    "services": [
		      {
		        "name": "descriptive-service-name",
		        "kind": "static_site" | "web_service",
		        "rootDir": "directory relative to the app root",
		        "runtime": "node" | "static",
		        "buildCommand": "the command to install deps and build",
		        "startCommand": "the command to start the server (web_service only)",
		        "staticPublishPath": "path to built output (static_site only)",
		        "healthCheckPath": "/health (web_service only)",
		        "envVars": [
		          { "key": "DATABASE_URL", "fromDatabase": { "property": "connectionString" } },
		          { "key": "VITE_API_HOST", "fromService": { "name": "api", "property": "host" } }
		        ]
		      }
		    ],
		    "databases": [
		      { "name": "descriptive-db-name" }
		    ]
		  }
		}

		The manifest must accurately describe every service you created.
		The workflow uses it to verify your build locally and to generate
		the Render Blueprint that deploys it.
	`,
};

export const deployManager: Agent = {
	id: "deploy-manager",
	description: "Watches Render deploys via MCP, diagnoses failures",
	model: "medium",
	renderTools: RENDER_READ_ONLY_TOOLS,
	maxTurns: 20,
	plan: "standard",
	prompt: md`
		You are the deploy manager. You monitor Render deployments via the
		read-only MCP tools you have and diagnose failures.

		You will receive a list of service names and their deploy status. For
		any service that failed, use your Render tools to:
		1. Look up the service by name to get its ID
		2. List its deploys to find the failing one
		3. Examine build logs and deploy details

		Then produce a diagnosis: what went wrong and what the builder should
		fix. Be specific — quote the exact error from the logs.

		Respond ONLY with JSON:
		{
		  "allHealthy": false,
		  "failures": [
		    {
		      "serviceName": "the service that failed",
		      "status": "build_failed",
		      "diagnosis": "exact error and what to fix",
		      "logs": "relevant log excerpt"
		    }
		  ]
		}

		If all services are healthy, respond with:
		{ "allHealthy": true, "failures": [] }
	`,
};

/* ── Registration ─────────────────────────────────────────────────────── */

export interface AgentTaskInput {
	message: string;
	sandboxId?: string;
}

/** JSON Schema for each agent's structured output, keyed by agent id. */
const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
	architect: zodToJsonSchema(deployPlanSchema),
	curator: zodToJsonSchema(assetManifestSchema),
	builder: zodToJsonSchema(buildOutputSchema),
	"deploy-manager": zodToJsonSchema(deployDiagnosisSchema),
};

/** Turn an Agent into a Render Workflows task. */
export function agentTask(agent: Agent) {
	return task(
		{ name: agent.id, plan: agent.plan },
		async function runAgent(input: AgentTaskInput): Promise<string> {
			const run = await runClaude({
				agentId: agent.id,
				systemPrompt: agent.prompt,
				prompt: input.message,
				model: airoConfig.models[agent.model],
				maxTurns: agent.maxTurns,
				tools: agent.tools,
				renderTools: agent.renderTools,
				sandbox: input.sandboxId ? connectSandbox(input.sandboxId) : undefined,
				outputSchema: OUTPUT_SCHEMAS[agent.id],
			});

			console.log(
				JSON.stringify({
					event: "agent_completed",
					agent: agent.id,
					model: airoConfig.models[agent.model],
					inputTokens: run.inputTokens,
					outputTokens: run.outputTokens,
				}),
			);

			// Prefer structured_output when the SDK enforced the schema.
			if (run.structuredOutput !== undefined) {
				return JSON.stringify(run.structuredOutput);
			}
			return run.result;
		},
	);
}

export const architectTask = agentTask(architect);
export const curatorTask = agentTask(curator);
export const buildTask = agentTask(builder);
export const deployManagerTask = agentTask(deployManager);

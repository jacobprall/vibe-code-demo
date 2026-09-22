/** The agents, in pipeline order, and how each becomes a Render task. */
import { task } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../factory.config.js";
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

		Default to only a static_site for websites, landing pages, portfolios,
		menus, directories, and read-only catalogs. Put their content in the
		site and implement search or filtering in the browser. A catalog alone
		does not justify an API or database.

		Add a web_service or postgres only when the product prompt explicitly
		requires behavior that cannot work in a static browser app, such as
		persistent user-written data, accounts, transactions, server-side
		integrations, or data that must change after deployment. Do not infer
		those requirements merely because they would make the app more
		production-like.

		assetQueries are what a photo researcher will search Wikimedia Commons
		for. Two to four words, concrete and photographable — "walnut dining
		chair", not "furniture" and not "handcrafted walnut dining chair in a
		sunlit workshop". Commons requires every word to match, so a sentence
		finds nothing.

		The brief is what the builder works from. Be specific about pages,
		features, voice, and real content: product names, prices, materials,
		copy directions, calls to action. Vague briefs produce placeholder
		websites.

		dataModel is required whenever you ask for postgres, and it is the whole
		specification the builder gets for the database: entities, their fields
		and types, and the actual seed rows — real values, not a description of
		what they would contain. Verification calls an endpoint that reads the
		database and fails the run if it comes back empty, so a data model
		without seed rows fails.

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
	// One asset__collect call, then the JSON. The old one-subject-at-a-time
	// loop cost two round trips per image and nothing else.
	maxTurns: 8,
	plan: "standard",
	prompt: md`
		You are the photo researcher. Find real, openly licensed photographs for
		the app being built and download them into it.

		Call asset__collect ONCE with every subject in your instructions and the
		assets directory you were given. It searches Wikimedia Commons for each
		subject in parallel, picks the largest usable photograph, and downloads
		them all. Do not call asset__search or asset__fetch per subject — that is
		far slower and gets you the same pictures.

		asset__collect returns what actually landed and what it skipped. Report
		only what landed. If it skipped a subject, leave it out rather than
		substituting something unrelated — a wrong photograph is worse than one
		fewer. Retry an individual subject with asset__search plus asset__fetch
		only if you have a specific reason to think a different search term would
		do better.

		Your judgment goes into two things: the alt text, which should describe
		what is actually in the photograph for someone who cannot see it, and the
		decision to drop a subject that came back wrong.

		Every image must carry the credit line asset__collect gave you; the site
		publishes it. Paths in your response are relative to the parent of the
		assets directory, e.g. assets/walnut-dining-chair.jpg.

		Respond ONLY with JSON describing what actually downloaded:
		{
		  "assets": [
		    {
		      "path": "assets/walnut-dining-chair.jpg",
		      "subject": "walnut dining chair",
		      "alt": "descriptive alt text for screen readers",
		      "credit": "credit line from asset__collect"
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

		Work fast. Every tool call is a round trip, so batch aggressively:
		write several files in one sandbox__exec using heredocs rather than one
		sandbox__write_file per file, and chain shell commands with && instead
		of calling exec repeatedly. Reach for sandbox__write_file only for a
		single large file where a heredoc would be awkward. Do not read a file
		back to confirm a write succeeded — a failed write reports itself.

		Rules:
		- When the approved plan contains only a static_site, prefer
		  dependency-free HTML, CSS, and JavaScript. Use a small shell build
		  command to copy the site into dist and set staticPublishPath to dist.
		  Do not initialize npm or a framework unless the product prompt
		  explicitly requires one.
		- Write real content — real product names, materials, prices, and copy.
		  No lorem ipsum, no "Coming soon", no remote image URLs. Prefer inline
		  SVG and CSS gradients for decoration. The result should look like
		  something a person shipped on purpose.
		- Photographs, when the instructions list any, are already downloaded
		  into the app's assets/ directory. Use those exact paths, move or copy
		  them wherever your build needs them, and publish every credit line.
		  Never invent an image path, and never reference one the instructions
		  did not give you.
		- Every web_service must serve a health endpoint that responds without
		  depending on a database, so Render's health check passes before
		  traffic arrives.
		- Do not run git — the workflow owns commits and deployment.
		- When you receive build output or Render deploy logs describing a
		  failure, fix exactly what the output names and nothing else.

		When the app has a database:

		- A real Postgres is already running in the sandbox and its URL is in
		  your instructions. Build against it. psql is on the PATH.
		- Put schema creation AND seeding in preDeployCommand. Render runs it
		  after the build and before the start command, and it is the only
		  chance the app gets to create its schema — nothing else applies it.
		  It runs on every deploy, so make it idempotent: CREATE TABLE IF NOT
		  EXISTS, INSERT ... ON CONFLICT DO NOTHING.
		- Set dataCheckPath to an endpoint that reads the database and returns
		  the seeded rows. Verification calls it, and an empty array fails the
		  run — that is how a missing seed gets caught before it deploys.
		- The API must send CORS headers. The storefront is a static site on a
		  different onrender.com host, so without Access-Control-Allow-Origin
		  every browser drops the response even though the API answers.
		- The storefront reaches the API through a build-time env var wired
		  with fromService. Its value is a bare hostname, not a URL, so build
		  "https://" + host. Default it to a localhost URL when it is unset, or
		  the sandbox build bakes in "undefined" and passes anyway.

		When you are done, respond with JSON describing what you built:
		{
		  "summary": "one paragraph describing what you built",
		  "manifest": {
		    "services": [
		      {
		        "name": "descriptive-service-name",
		        "kind": "static_site" | "web_service",
		        "rootDir": "subdirectory INSIDE the app directory, or \".\" if the service is the app directory itself. Never repeat the app directory path here.",
		        "runtime": "node" | "static",
		        "buildCommand": "the command to install deps and build",
		        "startCommand": "the command to start the server (web_service only)",
		        "preDeployCommand": "idempotent migrate + seed; required when the app has a database",
		        "staticPublishPath": "path to built output (static_site only)",
		        "healthCheckPath": "/health (web_service only)",
		        "dataCheckPath": "an endpoint that reads the database and returns rows",
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
	/** Workflow-owned. Relative paths in tool calls resolve against this. */
	workDir?: string;
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
				model: factoryConfig.models[agent.model],
				maxTurns: agent.maxTurns,
				tools: agent.tools,
				renderTools: agent.renderTools,
				sandbox: input.sandboxId ? connectSandbox(input.sandboxId) : undefined,
				workDir: input.workDir,
				outputSchema: OUTPUT_SCHEMAS[agent.id],
			});

			console.log(
				JSON.stringify({
					event: "agent_completed",
					agent: agent.id,
					model: factoryConfig.models[agent.model],
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

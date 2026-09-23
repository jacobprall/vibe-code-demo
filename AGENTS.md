# Repository guide for agents

This file applies to the entire repository.

## What this is

`vibe-code-demo` turns one authenticated prompt into a deployed application on
Render. It is a reference architecture for wiring a vibe-coding product to
Render Workflows, Sandboxes, Blueprints, Postgres, and the Render MCP server —
optimized to be read, not to be a framework.

The path is: a caller POSTs a prompt, the gateway validates and dispatches it,
and a workflow designs the app against Render primitives, gathers openly
licensed imagery, builds a storefront and an API in an isolated sandbox,
verifies them, and commits a Blueprint that Render deploys.

Two processes deploy independently:

- `app/server.ts` — Hono gateway web service.
- `app/host.ts` — Render Workflows host and task registration.

The gateway runs no models, holds no repository token, and creates no
infrastructure. Agents never write to GitHub and never call a Render write API.
Repository execution happens in a Render Sandbox.

## Quick start

Requires Node 22+, Docker for local Postgres, the Render CLI for
`dev:workflows`, and Render, GitHub, and Anthropic credentials.

```bash
npm ci
cp .env.example .env # then fill it in
```

Run each in its own terminal:

```bash
npm run dev:postgres
npm run db:migrate
npm run dev:gateway
npm run dev:workflows
```

The gateway listens on `0.0.0.0:${PORT:-3000}`. `GET /health` is liveness,
`GET /ready` checks Postgres and is the Render health-check target, prompts
arrive at `POST /v1/apps`, and runs are polled at `GET /v1/apps/:runId`. Local
workflow runs create real Render Sandboxes and deploy real services.

`dev:gateway` sets `RENDER_USE_LOCAL_DEV=true`, so the local gateway starts
tasks on the `dev:workflows` task server, which finds a task by its name and
ignores the slug. Set that variable only in `dev:gateway`, never in `.env`:
the workflows host loads `.env` too and must use the Render API.

Verify a change with `npm run check` (Biome, `tsc`, Vitest). For one file:
`npx vitest run tests/blueprint.test.ts`. Validate this repository's own
Blueprint with `render blueprints validate` when `render.yaml` changes.

`npm run doctor` diagnoses a live deployment and is read-only. When you add a
required environment variable, a task name, or a schema object, add a check for
it there — that script is where setup mistakes get caught.

`npm run demo` runs the end-to-end demo against a live gateway.

Production entrypoints are `npm run start:gateway` and
`npm run start:workflows`. `render.yaml` creates both services and the
database in the `vibe-factory` project, and sets the gateway's
`RENDER_WORKFLOW_SLUG` from the workflow with `fromService`. Keep that
environment's network isolation off: an isolated workflow cannot reach the
database. The generated-apps repository needs a one-time Blueprint watching
`main:render.yaml` with Auto Sync enabled.

The gateway also serves a browser UI at `/`. It is protected by HTTP Basic
Auth (`UI_USERNAME` and `UI_PASSWORD`) and submits through `/ui/apps`, which
keeps `FACTORY_API_KEY` server-side. Do not expose a browser route that bypasses
this protection. The authenticated `UI_USERNAME` is a validated lowercase slug
and is injected as the app namespace; never accept a browser-supplied `user`.
`GET /ui/apps` lists only that namespace's runs, and the UI restores selection
from local storage while treating Postgres as the source of truth.

## Repository map

Each concern is one file under `app/`. There are no barrels, no path aliases,
and no SDK layer — imports are relative with `.js` extensions (NodeNext).

The dependency direction is one-way:

```text
sandbox → tools → claude → agents → workflow
```

`policy` is imported by `claude` and defines the MCP allowlist. `render` is
imported by `claude` (for the MCP URL) and by `workflow`. `blueprint`, `git`,
and `store` are used by `workflow`; `gateway` uses `store`, `policy`, and
`contracts`. `config` and `contracts` are leaves. Adding an edge that points
backwards is a design smell.

```text
factory.config.ts   Directories, branch, plans, asset hosts, model tiers
app/
  config.ts      Environment parsing and per-process validation
  contracts.ts   Zod schemas for API input, agent output, and the stored spec
  gateway.ts     Bearer auth, body cap, dispatch, health, status
  agents.ts      The four agents, their prompts, and agentTask()
  claude.ts      The Agent type, runClaude(), md, parseModelJson, agentJson
  tools.ts       Sandbox tools, asset tools, and the Tool contract
  policy.ts      checkToolCall, path rules, MCP allowlist, secret redaction
  sandbox.ts     Render Sandboxes, shellEscape, Postgres in the sandbox
  blueprint.ts   render.yaml generation — the only write path to Render
  render.ts      MCP client, service and deploy reads, Blueprint lookup
  git.ts         Clone, commit, push, verify, GitHub credentials
  store.ts       Postgres: one runs table
  templates.ts   Read a template and materialize it into the sandbox
  workflow.ts    The prompt-to-app pipeline
  schema.sql     Schema, applied by scripts/migrate.ts
  server.ts      Gateway entrypoint
  host.ts        Workflows entrypoint
public/          Basic-Auth-protected prompt and deployment-status UI
templates/
  fullstack/     web/ (Vite + React + Tailwind + shadcn/ui), api/ (Hono + pg)
scripts/         migrate, doctor, demo, support
tests/           agents, blueprint, contracts, gateway, git, github-auth,
                 host, policy, render, shell, templates, tools
```

There is no `tasks.ts`, `scaffold.ts`, `shell.ts`, `github.ts`, or `format.ts`:
`agentTask()` lives in `agents.ts`, `shellEscape` beside the only thing that
executes a command in `sandbox.ts`, GitHub credentials in `git.ts`, and run
formatting in `gateway.ts`. The builder chooses its own stack, so there is no
skeleton to scaffold — the manifest it returns is what gets deployed.

## Conventions

- Strict TypeScript, ESM, NodeNext. Include `.js` in relative imports.
- Validate external and workflow input with Zod before use.
- Use `md` for dedented multi-line prompts.
- Escape shell arguments with `shellEscape`; use `execGitWithToken` for
  authenticated Git.
- Keep dispatch payloads small and JSON-serializable.
- Comments explain intent and constraints, not what the next line does.
- Add or update tests with behavior changes. Never call live Render, GitHub,
  Postgres, model, or Commons APIs from tests.

## Invariants

Do not weaken these without an explicit security-model change:

- One deployment is bound to one validated `APPS_REPO` and one branch.
- Only a request carrying the correct bearer token starts a run, and the token
  is compared in constant time.
- Browser submissions require valid UI Basic Auth. UI handlers reuse the same
  validation and claim path as `/v1`; no factory bearer token enters an HTML
  or JavaScript response.
- The body is capped before it is parsed.
- Agents receive only the tools listed in their definition. Claude's built-in
  `Bash`, `Read`, `Write`, and `Edit` are never granted — `claude.ts` always
  passes `tools: []` for built-ins.
- The architect gets no sandbox tools and only Render MCP tools from
  `RENDER_READ_ONLY_TOOLS`. `checkToolCall` denies every other Render tool, so
  the allowlist is enforced twice.
- The curator gets downloads and reads, never exec or write. Only the builder
 gets write and exec.
- Every agent-supplied path is resolved against the workflow-owned `workDir`
 on `ToolContext` and must land inside the checkout. `sandbox__exec` always
 `cd`s there first: the exec API starts in `/`, so an unresolved relative path
 builds an application outside the clone that no commit can ever see.
- `asset__fetch` accepts HTTPS only, allowlisted hosts only, `image/*` only,
  under the size cap, and only into an `assets/` directory in the checkout.
- `sandboxId` comes from workflow code, never from the model.
- Infrastructure is created only by committing a Blueprint. No code path calls
  a Render write API, and agents cannot run git.
- Verification is workflow-owned and runs the same install, build, and
  pre-deploy commands the Blueprint gives Render, against a real Postgres
  running in the sandbox. A health endpoint must answer with the database
  unreachable, because Render calls it before Postgres is ready; a
  `dataCheckPath` must return rows, because nothing else proves the schema was
  applied or the seed loaded.
- The push is verified against the remote SHA before the factory waits on a
  deploy.
- The sandbox is terminated in a `finally` block.
- Secret-shaped strings, including connection strings, are redacted from
  anything leaving the API.
- Render filesystems are ephemeral. Cross-process state goes in Postgres.

## Durability

There is no step memoization. A failed run is not resumed; the caller retries
by posting the prompt again. The gateway persists the Render task-run ID and
reconciles terminal Workflows state while polling, so an interrupted task
cannot leave a database row `running` forever. Long service, deploy, and HTTP
waits heartbeat `progress`; keep those waits bounded.

Postgres enforces two things through constraints rather than application code:
`runs.idempotency_key` is unique, so a retried curl cannot start a second run,
and the conditional insert in `claimRun` caps concurrent runs at
`factoryConfig.maxConcurrentRuns`.

If you add resumability, `ctx.step()` from Render Workflows' Durability 2.0
API is the seam. Do not rebuild a checkpoint store here.

## Add an agent

1. Add it to `app/agents.ts`. `id`, `model`, and `prompt` are required; `id` is
   also the registered task name, so keep it unique and stable. Give it `tools`
   only if it needs the sandbox, and `renderTools` only from
   `RENDER_READ_ONLY_TOOLS`.
2. Wrap it with `agentTask()` at the bottom of `app/agents.ts`, beside the
   other registrations.
3. Call it from the relevant stage in `app/workflow.ts`. Pass
   `sandboxId: sandbox.id` only when it declares tools.
4. If it emits JSON, add a schema to `app/contracts.ts`, register it in
   `OUTPUT_SCHEMAS`, and call it through `agentJson()`, which retries once and
   then fails closed.
5. Update `tests/agents.test.ts` for tool access, and add the task name to
   `tests/host.test.ts` and `scripts/doctor.ts`.

## Add a Render primitive

1. Add the kind to `TIER_KINDS` in `app/contracts.ts` if it is not there, and
   describe when to choose it in the architect's prompt.
2. Give the builder a way to declare it in `manifestSchema`, since the
   Blueprint is generated from the manifest rather than from the plan.
3. Emit its resource block from `serviceBlocks()` or `databaseBlocks()` in
   `app/blueprint.ts`; `projectBlock()` places it in the app's project
   environment. Wire dependent env vars declaratively with `fromDatabase` or
   `fromService` — never by reading a value back out of an API. A static site
   is not on the private network, and a browser uses its values. Give it only
   public values, such as `envVarKey: RENDER_EXTERNAL_HOSTNAME`. Never give it
   `host`, `port`, or `hostport`.
4. Extend `resourceNames()` so the new resource is namespaced by user and app
   and cannot collide with another resource in the same workspace.
5. Give `verify()` in `app/workflow.ts` a way to exercise it before the push.
   A primitive nothing verifies is a primitive that fails in production.
6. Add assertions to `tests/blueprint.test.ts`. That suite is the contract for
   what gets deployed.

`key_value` is in `TIER_KINDS` and goes no further: the manifest cannot
declare one and `blueprint.ts` cannot emit one, so an architect that asks for
it gets nothing. It is the worked example of where the next primitive plugs in.

## Change a template

`templates/fullstack` is a working three-tier app that a multi-service run
starts from. It exists for the contracts a prompt cannot reliably re-derive
every run — CORS, the API base URL built from the API's public hostname,
and an idempotent migrate-and-seed wired to `preDeployCommand`.

It lives here rather than in its own repository so it is version-locked to the
code that deploys it, and so CI builds it. If you change it:

1. Keep it building. `npm ci && npm run build` in both tiers is a CI job, and a
   template nobody builds is one that quietly stops building.
2. Keep the seed non-empty and both SQL files idempotent. Verification fails a
   run whose data endpoint returns no rows.
3. Update `templateLines()` in `app/workflow.ts` if the manifest it implies
   changes. `tests/templates.test.ts` pins the two together; that suite is what
   catches the template and the prompt drifting apart.
4. Templates are text only. They are materialized as one self-extracting shell
   script, so a binary file will not survive the trip.

## Change the pipeline

`app/workflow.ts` holds the linear narrative and its stages. Keep the narrative
readable — a new stage should read as one call with its detail in a function
below. Fetch large state inside the workflow rather than passing it through
dispatch, and keep repeated execution safe: a rerun of the same prompt
overwrites the app directory and rebases onto the branch.

Deployment progress distinguishes `waiting_for_services`,
`waiting_for_deploys`, and `smoke_testing`. Render reporting `live` is not
terminal: the public URL, data endpoint, and CORS checks must pass before the
run becomes `deployed`. The storefront check must also pass: the HTML of the
storefront, or a script that it loads, must contain the public hostname of the
API. The API checks cannot see the hostname that a browser uses.

New generated apps write `factory.json` with `resourcePrefix`. Root Blueprint
regeneration also reads the legacy filename and treats a missing prefix as the
legacy value. Do not remove that compatibility path until all existing app
specs have been migrated, or their Render resources will be renamed.

Helpers that outgrow the workflow file belong in a new `app/<concern>.ts`, not
in a subdirectory.

## Checklist

1. Trust boundaries between gateway, workflow, and agents are preserved.
2. New agents are registered at the bottom of `app/agents.ts` and task names
   match between definition, dispatch, `doctor`, and tests.
3. New external input is validated and task values stay JSON-serializable.
4. Infrastructure changes go through `app/blueprint.ts`, not an API call.
5. Sandbox cleanup and repeated side effects are safe.
6. `.env.example`, `render.yaml`, `docs/README.md`, `README.md`, `AGENTS.md`,
   and `scripts/doctor.ts` updated if configuration changed.
7. Browser UI changes preserve Basic Auth and never serialize secrets.
8. `npm run check` passes.

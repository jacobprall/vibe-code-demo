# Repository guide for agents

This file applies to the entire repository.

## What this is

`go-daddy-demo` turns one authenticated prompt into a deployed application on
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

Verify a change with `npm run check` (Biome, `tsc`, Vitest). For one file:
`npx vitest run tests/blueprint.test.ts`. Validate this repository's own
Blueprint with `render blueprints validate` when `render.yaml` changes.

`npm run doctor` diagnoses a live deployment and is read-only. When you add a
required environment variable, a task name, or a schema object, add a check for
it there — that script is where setup mistakes get caught.

`npm run demo` runs the end-to-end demo against a live gateway.

## Repository map

Each concern is one file under `app/`. There are no barrels, no path aliases,
and no SDK layer — imports are relative with `.js` extensions (NodeNext).

The dependency direction is one-way:

```text
shell → sandbox → tools → claude → agents → tasks → workflow
```

`policy` is imported by `claude` and defines the MCP allowlist. `render` is
imported by `claude` (for the MCP URL) and by `workflow`. `blueprint`,
`scaffold`, `git`, `github`, `store`, and `format` are used by `workflow` and
`gateway`. `config`, `contracts`, and `shell` are leaves. Adding an edge that
points backwards is a design smell.

```text
airo.config.ts   Directories, branch, plans, asset hosts, model tiers
app/
  config.ts      Environment parsing and per-process validation
  contracts.ts   Zod schemas for API input, agent output, and the stored spec
  gateway.ts     Bearer auth, body cap, dispatch, health, status
  agents.ts      The three agents and their prompts
  tasks.ts       agentTask() and the three registrations
  claude.ts      The Agent type, runClaude(), md, parseModelJson, agentJson
  tools.ts       Sandbox tools, asset tools, and the Tool contract
  policy.ts      checkToolCall, path rules, MCP allowlist, secret redaction
  sandbox.ts     Render Sandboxes
  shell.ts       shellEscape — quoting for every command we build
  scaffold.ts    The two-tier app skeleton and its fixed contract
  blueprint.ts   render.yaml generation — the only write path to Render
  render.ts      MCP client, service and deploy reads, Blueprint lookup
  git.ts         Clone, commit, push, verify — all workflow-owned
  github.ts      App or PAT credential resolution
  store.ts       Postgres: one runs table
  format.ts      Run state to public JSON
  workflow.ts    The prompt-to-app pipeline
  schema.sql     Schema, applied by scripts/migrate.ts
  server.ts      Gateway entrypoint
  host.ts        Workflows entrypoint
scripts/         migrate, doctor, demo, support
tests/           agents, blueprint, contracts, gateway, github-auth,
                 policy, render, shell, tools
```

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
- The body is capped before it is parsed.
- Agents receive only the tools listed in their definition. Claude's built-in
  `Bash`, `Read`, `Write`, and `Edit` are never granted — `claude.ts` always
  passes `tools: []` for built-ins.
- The architect gets no sandbox tools and only Render MCP tools from
  `RENDER_READ_ONLY_TOOLS`. `checkToolCall` denies every other Render tool, so
  the allowlist is enforced twice.
- The curator gets downloads and reads, never exec or write. Only the builder
  gets write and exec.
- `asset__fetch` accepts HTTPS only, allowlisted hosts only, `image/*` only,
  under the size cap, and only into a storefront's `web/public/assets`.
- `sandboxId` comes from workflow code, never from the model.
- Infrastructure is created only by committing a Blueprint. No code path calls
  a Render write API, and agents cannot run git.
- Verification is workflow-owned and runs the same install and build commands
  the Blueprint gives Render.
- The push is verified against the remote SHA before the factory waits on a
  deploy.
- The sandbox is terminated in a `finally` block.
- Secret-shaped strings, including connection strings, are redacted from
  anything leaving the API.
- Render filesystems are ephemeral. Cross-process state goes in Postgres.

## Durability

There is no step memoization. A failed run is not resumed; the caller retries
by posting the prompt again. Postgres enforces two things through constraints
rather than application code: `runs.idempotency_key` is unique, so a retried
curl cannot start a second run, and the conditional insert in `claimRun` caps
concurrent runs at `airoConfig.maxConcurrentRuns`.

If you add resumability, `ctx.step()` from Render Workflows' Durability 2.0
API is the seam. Do not rebuild a checkpoint store here.

## Add an agent

1. Add it to `app/agents.ts`. `id`, `model`, and `prompt` are required; `id` is
   also the registered task name, so keep it unique and stable. Give it `tools`
   only if it needs the sandbox, and `renderTools` only from
   `RENDER_READ_ONLY_TOOLS`.
2. Wrap it with `agentTask()` in `app/tasks.ts`.
3. Call it from the relevant stage in `app/workflow.ts`. Pass
   `sandboxId: sandbox.id` only when it declares tools.
4. If it emits JSON, add a schema to `app/contracts.ts` and call it through
   `agentJson()`, which retries once and then fails closed.
5. Update `tests/agents.test.ts` for tool access.

## Add a Render primitive

1. Add the kind to `TIER_KINDS` in `app/contracts.ts` if it is not there, and
   describe when to choose it in the architect's prompt.
2. Add it to `SUPPORTED` in `app/blueprint.ts` and emit its resource block in
   `serviceBlocks()` or `databaseBlocks()`. Wire dependent env vars
   declaratively with `fromDatabase` or `fromService` — never by reading a
   value back out of an API.
3. Handle it in `resolvePlan()` in `app/workflow.ts`, including the case where
   it is requested without the tier it depends on.
4. Extend `resourceNames()` so the new resource is namespaced by user and app.
5. Add assertions to `tests/blueprint.test.ts`. That suite is the contract for
   what gets deployed.

## Change the pipeline

`app/workflow.ts` holds the linear narrative and its stages. Keep the narrative
readable — a new stage should read as one call with its detail in a function
below. Fetch large state inside the workflow rather than passing it through
dispatch, and keep repeated execution safe: a rerun of the same prompt
overwrites the app directory and rebases onto the branch.

Helpers that outgrow the workflow file belong in a new `app/<concern>.ts`, not
in a subdirectory.

## Checklist

1. Trust boundaries between gateway, workflow, and agents are preserved.
2. New agents are registered in `app/tasks.ts` and task names match between
   definition, dispatch, `doctor`, and tests.
3. New external input is validated and task values stay JSON-serializable.
4. Infrastructure changes go through `app/blueprint.ts`, not an API call.
5. Sandbox cleanup and repeated side effects are safe.
6. `.env.example`, `render.yaml`, `README.md`, and `scripts/doctor.ts` updated
   if configuration changed.
7. `npm run check` passes.

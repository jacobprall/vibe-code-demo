# vibe-code-demo guide

This is a demonstration and pattern library. Use it to make architecture choices
concrete, then adapt the boundaries, supported primitives, verification, cost
controls, and user experience to your own requirements.

**Contents:** [When to use](#when-to-use-this-reference) ·
[Patterns](#production-patterns-demonstrated) ·
[Run lifecycle](#run-lifecycle) ·
[Blueprints](#why-blueprints-are-the-write-path) ·
[Apps repository](#the-apps-repository) ·
[Code map](#where-to-look-in-the-code) ·
[Get started](#get-started-local-development) ·
[Deploy](#deploy-the-factory) ·
[Configuration](#configuration) ·
[Troubleshooting](#troubleshooting-a-stuck-run) ·
[Adaptation](#adaptation-seams) ·
[Safety](#safety-boundaries) ·
[Limitations](#current-limitations)

## When to use this reference

Use vibe-code-demo when:

- You want to see an agent produce and deploy a multi-service application
  rather than stop at generated code.
- You need to demonstrate declarative infrastructure as the controlled write
  path while agents inspect the platform through read-only MCP tools.
- The design needs both pre-deploy evidence and post-deploy proof across a
  frontend, API, database, and browser security boundary.

Do not use it unchanged for untrusted public users. The included gateway has
simple authentication, one apps repository and branch, a small concurrency
cap, no tenant-level quotas, and no teardown workflow.

## Production patterns demonstrated

- **Separate ingress from privileged execution.** The gateway authenticates,
  caps input, records durable status, and dispatches; the Workflows host owns
  models, source credentials, sandboxes, and deployment coordination. This
  narrows the public attack surface, at the cost of operating two services.
- **Declarative infrastructure as the only write path.** Agents cannot create
  Render resources. Workflow code turns a validated manifest into Blueprints,
  commits them, and lets Render sync the desired state. The result is
  reviewable and reproducible, but the initial Blueprint connection is manual
  and only modeled primitives can be deployed.
- **Capabilities instead of prompt-only restrictions.** The architect gets a
  read-only Render MCP allowlist, the curator can fetch only validated image
  assets, and the builder can edit a sandbox but cannot run Git. Adding a new
  capability requires code and policy work, which is deliberate friction.
- **Templates encode contracts, not the whole application.** Multi-service
  apps start with known API, CORS, migration, and environment-wiring seams;
  the model still controls product-specific behavior and presentation. This
  improves reliability while narrowing stack freedom.
- **Verify locally and against reality.** The workflow builds, migrates, boots,
  and queries services in the sandbox, then waits for Render and smoke-tests
  public URLs, database access, and CORS. This catches integration failures a
  build cannot, but increases run time and infrastructure consumption.
- **Durable progress with reconciliation.** Postgres holds run state,
  idempotency, heartbeats, task IDs, and concurrency claims so clients can
  reconnect and stale runs can be repaired. That operational reliability adds
  a database and state machine to what could otherwise be a short demo script.

## Run lifecycle

1. An authenticated UI or API request is claimed in Postgres and dispatched
   with a prompt, user namespace, and run ID.
2. A read-only architect chooses supported Render primitives and produces a
   plan; no infrastructure changes occur.
3. One sandbox receives the apps repository. A curator supplies constrained
   media and a builder creates the application from an empty directory or a
   contract-bearing template.
4. Workflow-owned checks build, migrate, boot, and query the generated
   services. Failures can return to the builder for bounded repair rounds.
5. Workflow code derives `factory.json` and `render.yaml`, commits, pushes,
   and verifies the remote SHA. Blueprint sync—not an agent API call—creates
   the infrastructure.
6. The workflow waits for deployment. On failure, a deploy manager uses
   read-only Render MCP data to diagnose the deploy and can request one bounded
   builder repair; live services still must pass public storefront, health,
   data, and CORS checks.
7. Postgres exposes progress and final URLs to reconnecting clients; a
   `finally` block terminates the sandbox.

## Why Blueprints are the write path

Nothing in this repository calls a Render API to create infrastructure. The
factory writes YAML, commits it, and Render syncs it. That design has three
useful consequences:

- **Env wiring is declarative.** `fromDatabase` puts `DATABASE_URL` on the API
  and `fromService` puts the API's hostname into the storefront's build. No
  code ever reads a connection string, so no connection string can leak
  through one.
- **Every deploy is reviewable.** Everything the factory has ever provisioned
  is a diff in the apps repository.
- **An agent cannot provision anything.** Not because we asked it not to, but
  because the only path to a new service is a commit, and agents do not run
  git.

MCP is how the factory *reads* Render — service state, deploy status, build
logs — and how the architect explores the workspace while it designs.

## The apps repository

```text
render.yaml                            the Blueprint Render watches
apps/
  demo/
    handcrafted-furniture-catalog/
      factory.json                     machine-readable spec for this app
      render.yaml                      this app's own Blueprint
      README.md
      web/                             static storefront (rootDir)
      api/                             Hono + pg service (rootDir)
    gopher-dates/
      …
```

The root `render.yaml` is regenerated from every `factory.json` on each run, which
is why the specs are stored as JSON: appending an app never means parsing YAML
back out. Each app also carries its own self-contained `render.yaml`, so a
generated app can graduate out of the shared Blueprint — create a Blueprint
pointing at `apps/<user>/<app>/render.yaml` and it stands alone.

Resources are named `vibe-<user>-<app>-{web,api,db}`, so one workspace can hold
every generated app without collisions.

After you [deploy the factory](#deploy-the-factory), connect the apps repository
Blueprint once so pushes deploy automatically.

## Where to look in the code

- Start with `app/workflow.ts` for the control flow and `factory.config.ts` for
  configurable plans, limits, models, and asset policy.
- Read `app/blueprint.ts`, `app/contracts.ts`, and `app/templates.ts` together
  to see how model output becomes constrained deployable infrastructure.
- Read `app/claude.ts`, `app/tools.ts`, and `app/policy.ts` together to inspect
  the model-to-machine and model-to-Render trust boundaries.
- Read `app/gateway.ts` and `app/store.ts` for authentication, idempotency,
  progress, concurrency, and reconciliation.

For a presentation-sized system diagram, see
[Architecture at a glance](../README.md#architecture-at-a-glance). Field-demo
talking points live in [FAQ for field engineering](../FAQ.md).

Agent conventions and invariants are documented in [AGENTS.md](../AGENTS.md).

## Get started (local development)

### Prerequisites

- Node.js 22+ and Docker, for local Postgres
- The Render CLI, authenticated, and a workspace with Workflows and Sandboxes
- An Anthropic API key
- An empty GitHub repository for generated apps, and a credential that can push
  to it

### Install

```bash
npm ci
cp .env.example .env   # then fill it in
npm run dev:postgres
npm run db:migrate
```

Then, in separate terminals:

```bash
npm run dev:gateway    # http://localhost:3000
npm run dev:workflows  # needs the authenticated Render CLI
```

`dev:workflows` starts the Render CLI's local task server on port 8120.
`dev:gateway` sets `RENDER_USE_LOCAL_DEV=true`, so the gateway starts and
reads tasks on that server, not on a deployed Workflows service. The local
server finds a task by its name and ignores the slug, so the `.env.example`
value of `RENDER_WORKFLOW_SLUG` works. Do not put `RENDER_USE_LOCAL_DEV` in
`.env`: the workflows host loads that file too, and it must use the Render
API. If `dev:workflows` is not running, a submission fails with
`dispatch failed`. To see the tasks that the local server registered:

```bash
render workflows tasks list --local
```

`dev:workflows` runs locally but creates real Render Sandboxes and can deploy
real, billable resources. Local development changes where orchestration runs;
it does not emulate the Render data plane.

Open `http://localhost:3000` and sign in with `UI_USERNAME` and `UI_PASSWORD`.
The UI calls same-origin `/ui` endpoints; `FACTORY_API_KEY` stays on the
gateway and is never delivered to browser JavaScript. `UI_USERNAME` is also
the generated-app namespace: a user named `jacob` creates apps under
`apps/jacob/` with resources named `vibe-jacob-...`. It must be a lowercase
slug.

Submit an idea in the UI, or run the same flow from a terminal:

```bash
npm run demo -- "Create an online catalog for handcrafted furniture"
```

The command follows the durable status endpoint until it prints the generated
app's public URLs and Blueprint path.

Cursor’s embedded preview does not always display HTTP Basic Auth prompts. For
local preview only, set `UI_AUTH_DISABLED=true`; the bypass is ignored whenever
`NODE_ENV=production`.

## Deploy the factory

1. Create a Blueprint from this repository's `render.yaml`. It provisions the
   gateway, the Workflows service, and their Postgres database in the
   `production` environment of a `vibe-factory` project. It also sets
   `DATABASE_URL` on both services, and the gateway's `RENDER_WORKFLOW_SLUG`
   to the workflow's slug.
2. Fill in the unsynced variables when the Dashboard prompts for them. Each
   one is described in [Configuration](#configuration). For GitHub, set the
   three `GITHUB_APP_*` variables or `GITHUB_TOKEN`.
3. Run `npm run doctor` before a demonstration to verify the cross-service
   wiring.

If you created the Workflows service by hand before `render.yaml` defined it,
rename it to `vibe-factory-workflows` before the next Blueprint sync. The
Blueprint then adopts it and keeps its environment variables. Otherwise the
sync creates a second workflow without its secrets and points the gateway at
it.

### Connect the generated-apps Blueprint once

Render has no API for creating a Blueprint, so this is the one manual step —
and it happens once, not per app.

1. Run the factory once. The run commits its app and finishes as
   `awaiting_blueprint`, because nothing is watching the repository yet.
2. In the Render Dashboard: **New > Blueprint**, pick the apps repository,
   branch `main`, and leave Blueprint Path as `render.yaml`.
3. Confirm **Auto Sync** is on.

From then on every run deploys on push. `npm run doctor` checks all of this and
tells you which step is missing.

```bash
npm run doctor   # read-only; exits non-zero so CI can gate on it
npm run check    # Biome, tsc, Vitest
```

## Configuration

| Variable | Service | Purpose |
| --- | --- | --- |
| `APPS_REPO` | Both | The one repository generated apps are committed to |
| `FACTORY_API_KEY` | Gateway | Bearer token for `POST /v1/apps`; generated by the Blueprint, set manually for local development |
| `UI_USERNAME` | Gateway | UI login and generated-app namespace; lowercase slug |
| `UI_PASSWORD` | Gateway | HTTP Basic Auth password; 16+ characters |
| `RENDER_WORKFLOW_SLUG` | Gateway | Workflows service slug, without a task name |
| `DATABASE_URL` | Both | Postgres connection string for the runs table |
| `RENDER_API_KEY` | Both | Task dispatch; Sandboxes, MCP, and Blueprint reads |
| `RENDER_WORKSPACE_ID` | Workflows | Workspace sandboxes and services live in |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_APP_ID` | Workflows | GitHub App ID (preferred over a PAT) |
| `GITHUB_APP_PRIVATE_KEY` | Workflows | PEM, escaped PEM, or base64 |
| `GITHUB_APP_INSTALLATION_ID` | Workflows | Installation on `APPS_REPO` |
| `GITHUB_TOKEN` | Workflows | Fine-grained PAT; fallback when no App is set |
| `RENDER_MCP_URL` | Workflows | Optional MCP endpoint override |
| `FACTORY_GATEWAY_URL` | CLI | Optional gateway used by `npm run demo` |
| `FACTORY_USER` | CLI | Optional generated-app namespace used by the demo |
| `PORT` | Gateway | Optional HTTP port; defaults to `3000` |

Everything else lives in `factory.config.ts`: the clone directory, the branch the
Blueprint tracks, service and database plans, region, the asset host allowlist,
the concurrency cap, and the model tiers.

Copy `.env.example` when setting up locally.

## Troubleshooting a stuck run

`GET /v1/apps/:runId` returns both a coarse `stage` and a human-readable
`progress` value:

- `waiting_for_services`: Blueprint sync has not created every expected service.
- `waiting_for_deploys`: at least one Render deploy has not reached a terminal state.
- `smoke_testing`: deploys are live; public URL, data, or CORS checks are still running.
- `done`: the stored run is terminal.

All deploy and HTTP waits have deadlines and heartbeat the database. The
gateway also stores the Render task-run ID and periodically reconciles a
`running` row with Workflows. If the task succeeded, failed, or was canceled
without finalizing Postgres, the next status poll repairs the row and releases
its concurrency slot.

Run `npm run doctor` to verify factory and Blueprint wiring before debugging individual runs.

## Adaptation seams

- **Render primitives:** extend the manifest contract, Blueprint generator, and
  verification together. Keeping that path closed forces each resource type to
  be modeled deliberately instead of accepting arbitrary agent-authored YAML;
  the current `key_value` mismatch is called out under [Current limitations](#current-limitations).
- **Agent roles:** add a task only when a distinct context or capability
  boundary is useful. Grant sandbox or Render tools explicitly and keep the
  allowlist test as the executable access review.
- **Templates:** add one when a target architecture has contracts the model
  should not rediscover on every run. Keep templates versioned and built in CI;
  the tradeoff is committing to a narrower stack.
- **External assets:** treat each new source as an egress-policy change, not
  just a search integration. Host, content type, size, and destination checks
  belong in the tool boundary.
- **Review:** this demo favors deterministic and deployed checks over model
  reviewers. For higher-risk generation, add review before publishing as
  `render-factory` does, accepting the extra latency and model cost.

See [AGENTS.md](../AGENTS.md) for checklists when adding agents, primitives, or pipeline stages.

## Safety boundaries

- The bearer token is compared in constant time, and the body is capped before
  it is parsed.
- The gateway never receives the GitHub credential or the Anthropic key.
- Claude's built-in `Bash`, `Read`, `Write`, and `Edit` are never granted;
  `runClaude` always passes `tools: []` for built-ins. Every action an agent
  takes goes through a workflow-owned sandbox tool.
- `preDeployCommand` is agent-authored and runs in the sandbox and again on
  Render, so it goes through the same destructive-command gate as the build
  and start commands before either happens.
- `checkToolCall` runs as a `PreToolUse` hook and vetoes destructive commands,
  secret exfiltration, paths outside the clone, and any Render MCP tool that is
  not on the read-only allowlist.
- Agents cannot run git, so they cannot publish; the trigger for a deploy is a
  commit only workflow code can make.
- `asset__fetch` accepts only HTTPS, only allowlisted hosts, only `image/*`
  responses under the size cap, and only destinations inside an `assets/`
  directory in the checkout.
- The push is verified against the remote SHA before the factory waits on a
  deploy, so Render is always building the commit that passed verification.
- Malformed structured model output fails closed after one repair attempt.
- Secret-shaped strings, including anything resembling a connection string, are
  redacted from API responses.
- The sandbox is terminated in a `finally` block.
- Postgres enforces idempotency and the concurrency cap through constraints
  rather than application code.

Implementation details and invariants for contributors are in [AGENTS.md](../AGENTS.md).

## Current limitations

- Every run, including one started from local development, consumes model
  tokens and a real Render Sandbox.
- Creating the Blueprint is manual, once, because Render has no API for it.
- A workspace can hold only one factory from this `render.yaml`. Render does
  not yet replicate workflows, so it rejects a second Blueprint that defines
  `vibe-factory-workflows`.
- One deployment is bound to one apps repository and one branch. Concurrent
  runs rebase onto that branch; the cap is three at a time.
- UI authentication and user slugs are demonstration conveniences, not
  tenant isolation, authorization, quotas, or abuse controls.
- Generated apps are never torn down. Every run leaves a web service, a static
  site, and a Postgres instance running, and they cost money until you delete
  them.
- Generated apps run on paid plans by default: free web services spin down
  after 15 minutes, and a workspace only gets one free Postgres.
- The sandbox's Postgres is a fresh 18 with no extensions installed, so an app
  that needs one will pass verification only if it installs it itself.
- `key_value` is in `TIER_KINDS` and nowhere else, so an architect that asks
  for one gets nothing and no warning.
- No reviewer stage, step-level resumability, or teardown workflow. Terminal
  Workflows runs are reconciled, but a failed task restarts from the beginning.
- A failed task run is not resumed; retry by calling the API again.

## Related

- [FAQ for field engineering](../FAQ.md) — live-demo talking points and quick answers

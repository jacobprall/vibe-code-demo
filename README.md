# vibe-code-demo

A prompt-to-deploy reference application for Render. Submit an idea in the
protected browser UI (or call the API) and the factory designs, builds,
verifies, and deploys a static storefront, API, and Postgres database using
Render Workflows, Sandboxes, Blueprints, and the Render MCP server.

The gateway serves the UI at `/`, exposes an authenticated API under `/v1`,
and stores progress in Postgres so the browser can reconnect to an active run.

```bash
curl -X POST https://<gateway>/v1/apps \
  -H "Authorization: Bearer $FACTORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Create an online catalog to sell handcrafted furniture","user":"demo"}'
```

```json
{ "runId": "…", "user": "demo", "status": "running", "statusUrl": "/v1/apps/…" }
```

Poll `statusUrl` and a few minutes later it holds the live URLs:

```json
{
  "status": "deployed",
  "appName": "handcrafted-furniture-catalog",
  "urls": {
    "web": "https://vibe-demo-handcrafted-furnitu-web.onrender.com",
    "api": "https://vibe-demo-handcrafted-furnitu-api.onrender.com"
  },
  "blueprintPath": "apps/demo/handcrafted-furniture-catalog/render.yaml"
}
```

`npm run demo` does both halves from a terminal. The browser UI shows the same
stages and turns the final URL into an “Open deployed app” link.

## How a run works

1. **The gateway** authenticates the bearer token, caps the prompt, claims the
   run in Postgres, and dispatches `{ prompt, user, runId }`. It runs no
   models, holds no repository credential, and creates no infrastructure.
2. **The architect** decides what to build and which Render primitives it
   needs. It can read the Render workspace over MCP — `list_services`,
   `get_service`, `get_postgres` — and it can change nothing. For a catalog it
   returns a static site, a web service, and Postgres, each with a reason, plus
   a content brief and a list of subjects to photograph.
3. **A Render Sandbox** is created and the apps repository is cloned into it at
   `apps/<user>/<app>/`. When the plan calls for Postgres, a real Postgres 18
   starts inside the sandbox — the image already carries the client and the
   pgdg apt source, so the server is a ten-second install.
4. **The curator** searches Wikimedia Commons for openly licensed photographs
   and downloads them into the app's `assets/` directory. It has no shell and
   no file write tool: the only bytes it can create are images that passed the
   factory's host, type, size, and destination checks.
5. **The builder** writes the application. A single-tier app starts from an
   empty directory and the builder picks its own stack; a multi-service app
   starts from `templates/fullstack` — Vite, React, Tailwind v4 and shadcn/ui
   for the storefront, Hono and `pg` for the API — because CORS, the API base
   URL, and the migration path are contracts a prompt should not have to
   re-derive every run. Either way the builder returns a manifest describing
   what it built: directories, build and start commands, the pre-deploy
   command that creates the schema, health and data endpoints, and env wiring.
6. **Verification** is deterministic and workflow-owned, and driven by that
   manifest: each service's build command, an `index.html` check for static
   output, a placeholder-content check, the pre-deploy command run against the
   sandbox's Postgres, and two boots of each web service — one with an
   unreachable database to prove the health endpoint answers without one, and
   one against the real database to prove the data endpoint returns rows.
   Failures go back to the builder for up to two more rounds.
7. **Publishing is deploying.** Workflow code writes the app's `factory.json`,
   its own `render.yaml`, and the repository-root Blueprint, then commits and
   pushes. Render's Blueprint sync creates the services and the database and
   deploys them.
8. **Verification, again, against reality.** The factory waits for every
   deploy, fetches the storefront, calls the health endpoint, and calls the
   data endpoint with the storefront's `Origin` — the first request that
   touches the deployed Postgres, and the only one that can see a missing
   `Access-Control-Allow-Origin`. If a Render build fails, its build logs go
   back to the builder for one repair round, and the fix redeploys on push.

```text
POST /v1/apps
  │  bearer auth → prompt cap → claim in Postgres → dispatch
  ▼
Render Workflows: prompt-to-app
  ├─ architect   plan + primitives + brief        ← Render MCP, read-only
  ├─ postgres    a real database in the sandbox   ┐
  ├─ curator     openly licensed photography      │
  ├─ builder     storefront + API + schema        │ one Render Sandbox
  ├─ verify      build, migrate, boot, query      │
  ├─ publish     factory.json + render.yaml + push   ┘
  ├─ sync        Render deploys the Blueprint
  └─ smoke       storefront 200, health 200, data endpoint returns rows + CORS
  ▼
GET /v1/apps/:runId → { status, stage, urls, blueprintPath }
```

After Render reports every service `live`, the workflow intentionally remains
active during `smoke_testing`. It fetches the public site, exercises the API
and database, and validates CORS before reporting `deployed`.

## Why Blueprints are the write path

Nothing in this repository calls a Render API to create infrastructure. The
factory writes YAML, commits it, and Render syncs it. That has three
consequences worth the design:

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

## Architecture

Two processes deploy independently: the Hono gateway (`app/server.ts`) and the
Workflows host (`app/host.ts`). One file per concern:

```text
factory.config.ts   Directories, branch, plans, asset hosts, model tiers
app/
  config.ts      Environment parsing and per-process validation
  contracts.ts   Zod schemas: API input, agent output, the stored spec
  gateway.ts     Bearer auth, body cap, dispatch, health, status
  agents.ts      The four agents, their prompts, and agentTask()
  claude.ts      The Agent type and runClaude() over the Claude Agent SDK
  tools.ts       Sandbox tools, asset tools, and the Tool contract
  policy.ts      checkToolCall, path rules, MCP allowlist, redaction
  sandbox.ts     Render Sandboxes, shellEscape, Postgres in the sandbox
  blueprint.ts   render.yaml generation: the only write path to Render
  render.ts      MCP client, service and deploy reads, Blueprint lookup
  git.ts         Clone, commit, push, verify, GitHub credentials
  store.ts       Postgres: one runs table
  templates.ts   Read a template and materialize it into the sandbox
  workflow.ts    The pipeline, top to bottom
  schema.sql     Applied by scripts/migrate.ts
  server.ts      Gateway entrypoint
  host.ts        Workflows entrypoint
```

### Reading order

| Start here | For |
| --- | --- |
| `factory.config.ts` | Every knob |
| `app/workflow.ts` | The whole pipeline, top to bottom |
| `app/blueprint.ts` | What actually gets deployed, and where to extend it |
| `app/agents.ts` | The four agents and their prompts |
| `app/tools.ts` | Everything an agent can do, including the asset fetcher |
| `app/policy.ts` | The one gate between a model and the machine |
| `app/gateway.ts` | How a curl becomes a dispatched run |

## Get started

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

Open `http://localhost:3000` and sign in with `UI_USERNAME` and `UI_PASSWORD`.
The UI calls same-origin `/ui` endpoints; `FACTORY_API_KEY` stays on the
gateway and is never delivered to browser JavaScript. `UI_USERNAME` is also
the generated-app namespace: a user named `jacob` creates apps under
`apps/jacob/` with resources named `vibe-jacob-...`. It must be a lowercase
slug.

Cursor’s embedded preview does not always display HTTP Basic Auth prompts. For
local preview only, set `UI_AUTH_DISABLED=true`; the bypass is ignored whenever
`NODE_ENV=production`.

For a deployed Workflows host, create a **Workflow** service separately in the
Render Dashboard (Blueprints do not create Workflow services). Use
`npm ci` as the build command and `npm run start:workflows` as the start
command, then copy the workflow variables from `.env.example`.

### Create the Blueprint, once

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
| `FACTORY_API_KEY` | Gateway | Bearer token for `POST /v1/apps`; 24+ characters |
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

### Compatibility migration

New installations use neutral names and write `factory.json`. Existing
generated-app repositories remain safe: the root Blueprint reader accepts the
legacy spec filename, and specs created before the rename retain their
original resource prefix. `FACTORY_API_KEY` also accepts the former variable
as a temporary fallback. Set the new variable everywhere before removing the
old one.

Renaming the factory's own database or gateway in an already-synced Blueprint
creates replacement resources; migrate that infrastructure deliberately
rather than applying the new names blindly.

## Troubleshooting a run that looks stuck

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

## Extending

**Another primitive.** `app/blueprint.ts` emits `static_site`, `web_service`,
and `postgres`, all of them generated from the builder's manifest rather than
from the plan. The architect can already ask for `key_value`, and nothing
downstream can express one, so it is silently dropped — it is the worked
example of where the next primitive plugs in. Adding one means a way to
declare it in `manifestSchema`, a resource block in `serviceBlocks()` or
`databaseBlocks()`, a name in `resourceNames()`, and a check in `verify()`.

**Another agent.** Add it to `app/agents.ts`, wrap it with `agentTask()` at the
bottom of that file, call it from `app/workflow.ts`, and give it a Zod schema
in `app/contracts.ts` if it emits JSON. Give it `tools` only if it needs the
sandbox, and `renderTools` only from the read-only allowlist. Update
`tests/agents.test.ts`, which is what enforces tool access.

**Another template.** `templates/<name>/` is materialized into the app
directory by `materializeTemplate()` before the builder runs. Templates live in
this repository so they stay version-locked to the code that deploys them and
so CI builds them — a template nobody builds is one that quietly stops
building. They are text only: the whole tree ships as one self-extracting shell
script, because a forty-file template written a file at a time would be eighty
API calls before the builder has done anything. If you add one, update
`templateLines()` in `app/workflow.ts` and `tests/templates.test.ts`, which is
what keeps the template and the manifest the builder is told to return in sync.

**Another asset source.** `asset__search` and `asset__fetch` in `app/tools.ts`
are the whole of the factory's reachable internet. Add a host to
`factoryConfig.assets.allowedHosts` and a search implementation; the type, size,
and destination checks already apply.

**Reviewers.** This fork has none — it verifies by building and by calling the
deployed app. The upstream `render-factory` runs security, correctness, and
test reviewers in parallel with a judge before anything ships, and that stage
drops in between verification and publishing.

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

## Current limitations

- Creating the Blueprint is manual, once, because Render has no API for it.
- One deployment is bound to one apps repository and one branch. Concurrent
  runs rebase onto that branch; the cap is three at a time.
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

## License

MIT

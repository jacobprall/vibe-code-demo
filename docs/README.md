# vibe-code-demo guide

This is a demonstration and pattern library. Use it to make architecture choices
concrete, then adapt the boundaries, supported primitives, verification, cost
controls, and user experience to your own requirements.

**Contents:** [When to use](#when-to-use-this-reference) ·
[Patterns](#production-patterns-demonstrated) ·
[Run lifecycle](#run-lifecycle) ·
[Delete an app](#delete-an-app) ·
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
cap, and no tenant-level quotas.

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
- **Delete in the order that the declarative system allows.** A Blueprint
  never deletes a resource, and it recreates a declared resource that is
  missing. So a delete first takes the app out of the Blueprint, waits until
  no sync of an earlier commit can run, and only then calls the Render API,
  scoped to the app's own project. These are the only Render write API calls
  in the factory. The cost is a second commit and a wait of about a minute.
- **Capabilities instead of prompt-only restrictions.** The architect gets a
  read-only Render MCP allowlist, the curator can fetch only validated image
  assets, and the builder can edit a sandbox that holds only its app, with no
  credential to publish. Adding a new capability requires code and policy
  work, which is deliberate friction.
- **Build without credentials, and publish from a clean sandbox.** The builder
  can run any command in its sandbox, so that sandbox gets no clone of the apps
  repository and no GitHub token. `publish-app` copies the app's regular files
  out of it as data, into a new clone in a sandbox of its own, and commits
  only that app's directory and the root Blueprint. CI systems that build
  untrusted code without secrets and publish from a different job use the
  same pattern. The cost is one more sandbox for each push.
- **Templates encode contracts, not the whole application.** Multi-service
  apps start with known API, CORS, migration, and environment-wiring seams;
  the model still controls product-specific behavior and presentation. This
  improves reliability while narrowing stack freedom.
- **Verify locally and against reality.** The workflow builds, migrates, boots,
  and queries services in the sandbox, then waits for Render and smoke-tests
  public URLs, the API hostname in the storefront, database access, and CORS.
  This catches integration failures a build cannot, but increases run time and
  infrastructure consumption.
- **Durable progress with reconciliation.** Postgres holds run state,
  idempotency, heartbeats, task IDs, and concurrency claims so clients can
  reconnect and stale runs can be repaired. That operational reliability adds
  a database and state machine to what could otherwise be a short demo script.

## Run lifecycle

1. An authenticated UI or API request is claimed in Postgres and dispatched
   with a prompt, user namespace, and run ID.
2. A read-only architect chooses supported Render primitives and produces a
   plan; no infrastructure changes occur.
3. One sandbox receives an empty app directory, with no clone of the apps
   repository and no credential. A curator supplies constrained media and a
   builder creates the application from an empty directory or a
   contract-bearing template.
4. The `verify-app` subtask builds, migrates, boots, and queries the
   generated services. Its checks start from only the files a commit holds, as
   Render's fresh clone does, and it checks that `publish-app` can copy them.
   Failures can return to the builder for bounded repair rounds.
5. The `publish-app` subtask copies the app's regular files into a new clone
   in a sandbox of its own. There it derives `factory.json` and `render.yaml`,
   commits only the app's directory and the root Blueprint, pushes, and
   verifies the remote SHA. Blueprint sync—not an agent API call—creates the
   infrastructure.
6. The workflow waits for deployment. On failure, a deploy manager uses
   read-only Render MCP data to diagnose the deploy and can request bounded
   builder repairs. `verify-app` verifies each repair, and `publish-app`
   rewrites `factory.json` and `render.yaml` from its manifest and pushes
   again. Then the workflow waits for a new deploy of each failed service, not
   for the deploy that failed. A repair cannot add or remove a resource: a
   Blueprint sync never deletes one, and the loop watches only the services of
   the first push. Live services still must pass public storefront, API
   hostname, health, data, and CORS checks.
7. Postgres exposes progress and final URLs to reconnecting clients; a
   `finally` block terminates the sandbox.

Each agent, `verify-app`, and `publish-app` is a subtask of `prompt-to-app`.
In the Render Dashboard, each one is a run of its own under the
`prompt-to-app` run, with its input, its result, and its logs. The curator,
the builder, and `verify-app` work in the sandbox of the run, and
`publish-app` reads the app's files from it. They find it by the `sandboxId`
in their input. `publish-app` pushes from a sandbox of its own.

| Task | Result | Events |
| --- | --- | --- |
| `verify-app` | `failures`: the full text of each check that failed, or `[]` | `app_verified`; `app_verification_failed`, with the first line of each failure |
| `publish-app` | `commit`: the pushed commit, or `null` when no file changed | `app_published`, with the commit |

## Delete an app

`DELETE /v1/apps/:runId`, or **Delete app** in the UI, deletes the app that a
run built. The runs of one app share its directory and its Render resources,
so every run of the app is deleted with it. A run that did not choose an app
has nothing else, and the gateway deletes it at once.

1. The gateway claims every run of the app as `deleting` and dispatches the
   `delete-app` task. While a run of the app is still running, it refuses with
   `409`. A run that chooses the app while the delete is in progress stops
   before it builds.
2. `remove-app-from-blueprint` writes `deletedAt` into the app's
   `factory.json` and pushes a root `render.yaml` without the app. This commit
   removes no source file, so a service that builds from it still has all of
   its files.
3. `wait-for-blueprint-syncs` waits a minute, and then until no sync of the
   Blueprint waits or runs. Only a sync of an earlier commit still declares
   the app, and that sync would recreate a resource that the delete removed. A
   push that only removes resources starts no sync, and Render still lists the
   resources under the Blueprint, so that list is no signal.
4. `delete-app-resources` deletes the app's services, then its databases and
   their data, and then the app's Render project. In that project, it deletes
   only the resources whose names start with `vibe-<user>-<app>-`. Any other
   resource stays, and so does the project.
5. `remove-app-files` removes `apps/<user>/<app>/` in a second commit. Then
   `delete-app` deletes the runs.

```bash
curl -X DELETE -H "Authorization: Bearer $FACTORY_API_KEY" "$GATEWAY_URL/v1/apps/$RUN_ID"
```

While the status is `deleting`, `GET /v1/apps/:runId` shows the step in
`progress`. When the delete is done, it returns `404`. A delete that fails sets
`delete_failed`, with the reason in `summary`. Fix the cause and send the
`DELETE` again: the new attempt continues from where the last one stopped. The
app's files stay in the Git history of the apps repository.

Steps 2 to 5 are subtasks of `delete-app`. In the Render Dashboard, each one is
a run of its own under the `delete-app` run, with its input, its result, and
its logs. Each log line is a JSON object with an `event`:

| Task | Events |
| --- | --- |
| `remove-app-from-blueprint` | `app_removed_from_blueprint`, with the commit, or `null` when an earlier attempt pushed it; `app_spec_not_found` |
| `wait-for-blueprint-syncs` | `push_event_wait`; `blueprint_syncs_unfinished` each time the list of unfinished syncs changes; `blueprint_syncs_finished`; `blueprint_not_found`; `render_read_failed` for each failed read of Render, with the attempt and the error |
| `delete-app-resources` | `render_resource_deleted` and `render_resource_kept` for each resource; `render_project_not_empty` for each refused attempt; `render_project_deleted`; `render_project_not_found` |
| `remove-app-files` | `app_files_removed`, with the commit |
| `delete-app` | `app_deleted`, with the deleted resources; `app_delete_failed`, with the error |

## Why Blueprints are the write path

Nothing in this repository calls a Render API to create infrastructure. The
factory writes YAML, commits it, and Render syncs it. That design has three
useful consequences:

- **Env wiring is declarative.** `fromDatabase` puts `DATABASE_URL` on the API
  and `fromService` puts the API's public hostname into the storefront's build. No
  code ever reads a connection string, so no connection string can leak
  through one.
- **Every deploy is reviewable.** Everything the factory has ever provisioned
  is a diff in the apps repository.
- **An agent cannot provision anything.** Not because we asked it not to, but
  because the only path to a new service is a commit, and agents do not run
  git.

MCP is how the factory *reads* Render — service state, deploy status, build
logs — and how the architect explores the workspace while it designs.

Deletion is the one exception to the rule. A Blueprint change never deletes a
resource, so `app/teardown.ts` calls the Render API to delete the resources of
a deleted app, after the app has left the Blueprint. See
[Delete an app](#delete-an-app).

## The apps repository

```text
render.yaml                            the Blueprint Render watches
apps/
  demo/
    handcrafted-furniture-catalog/
      factory.json                     machine-readable spec for this app
      render.yaml                      this app's own Blueprint
      README.md
      .gitignore                       node_modules/ and static build output
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

Each app's `.gitignore` comes from its manifest. It ignores `node_modules/` and
each static site's publish directory, because the `buildCommand` makes them
again on Render. Verification deletes every ignored file before it builds, so
a build that needs one fails in the sandbox and not in a deploy.

Resources are named `vibe-<user>-<app>-{web,api,db}`, so one workspace can hold
every generated app without collisions. Each app is also its own Render
project, named `vibe-<user>-<app>`, with one `production` environment that
holds its site, API, and database, so the Dashboard groups them by app.

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
- Read `removeApp()` in `app/workflow.ts` and then `app/teardown.ts` for the
  order of a delete and what it can delete.

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
2. In the Render Dashboard, open the workspace that `RENDER_WORKSPACE_ID`
   names. The factory looks for the Blueprint only there. Then **New >
   Blueprint**, pick the apps repository, branch `main`, and leave Blueprint
   Path as `render.yaml`.
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
| `RENDER_API_KEY` | Both | Task dispatch; Sandboxes, MCP, and Blueprint reads; the deletes of a deleted app's resources |
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

- `verifying`: `verify-app` builds, boots, and queries the app in the sandbox. If it does not finish in 30 minutes, for example because a build command does not exit, the run ends as `failed`.
- `waiting_for_services`: Blueprint sync has not created every expected service.
- `waiting_for_deploys`: at least one Render deploy has not reached a terminal state. After a repair push, it can also mean that Render has not started the new deploy of a failed service yet. If Render does not start one in 15 minutes, the run ends as `deploy_failed`.
- `smoke_testing`: deploys are live; public URL, API hostname, data, or CORS checks are still running.
- `done`: the stored run is terminal.

All deploy and HTTP waits have deadlines and heartbeat the database. The
gateway also stores the Render task-run ID and periodically reconciles a
`running` or `deleting` row with Workflows. If the task succeeded, failed, or
was canceled without finalizing Postgres, the next status poll repairs the row
and releases its concurrency slot.

A service or deploy wait does a failed Render read again after five seconds,
and `progress` shows the attempt and the error. Five failures in sequence end
the run as `failed`, with the last error in `summary`. An authentication
failure (401 or 403) ends the run at once, because a new attempt cannot repair
the API key. The Blueprint lookup does a failed request again in the same way.
If the lookup cannot finish, the run ends as `failed`, not as
`awaiting_blueprint`.

While a delete runs, the status is `deleting`, and `progress` names the step.
`wait-for-blueprint-syncs` does a failed Render read again in the same way.
Five failures in sequence, or a 401 or 403, end the delete as
`delete_failed`. A `delete_failed` run keeps the reason in `summary`. Two
causes need you to act before you delete again:

- A sync of the apps Blueprint did not finish in six minutes. Let it finish,
  or fix it, in the Render Dashboard.
- The app's project holds a resource that the factory did not create. Delete
  or move it in the Render Dashboard.

In the Render Dashboard, the run of the step that failed is under the
`delete-app` run. For the first cause, `wait-for-blueprint-syncs` logs each
sync that did not finish in a `blueprint_syncs_unfinished` event. For the
second, `delete-app-resources` logs the resource, with its ID, in a
`render_resource_kept` event.

Run `npm run doctor` to verify factory and Blueprint wiring before debugging individual runs.

## Adaptation seams

- **Render primitives:** extend the manifest contract, Blueprint generator, and
  verification together. Keeping that path closed forces each resource type to
  be modeled deliberately instead of accepting arbitrary agent-authored YAML.
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
  secret exfiltration, paths outside the app directory and `/tmp`, and any
  Render MCP tool that is not on the read-only allowlist.
- The sandbox that the agents use holds only the app of the run: no clone of
  the apps repository and no GitHub token. So an agent cannot publish, and it
  cannot read or change another app. The trigger for a deploy is a commit that
  only workflow code can make.
- `publish-app` treats the files of the build as data. It copies only regular
  files with plain paths below the app directory, up to 50 MB, and pushes
  from a clone in a sandbox that no agent used. The clone checks out a
  symbolic link as a plain file.
- Each commit changes only `apps/<user>/<app>/` and the root `render.yaml`,
  and the push refuses a commit that changes a different path. The root
  Blueprint takes a spec only from the directory of the app that it names.
- The only Render write API calls are the deletes in `app/teardown.ts`. The
  `delete-app-resources` step of the `delete-app` task makes them, never an
  agent, and only when no sync of the Blueprint waits or runs. They delete only
  resources that carry
  the app's name, in the app's own project. The UI can delete only the runs of
  its own namespace.
- A delete and a run of the same app take the same Postgres advisory lock, so a
  run cannot build an app while it is being deleted.
- `asset__fetch` accepts only HTTPS, only allowlisted hosts, only `image/*`
  responses under the size cap, and only destinations inside an `assets/`
  directory in the app directory.
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
- Generated apps keep running until you delete them. Every run leaves a web
  service, a static site, and a Postgres instance running, and they cost money
  until then.
- A delete removes an app with all of its runs, not one run, because the runs
  of an app share its files and resources. The files stay in the Git history.
- Generated apps run on paid plans by default: free web services spin down
  after 15 minutes, and a workspace only gets one free Postgres.
- The sandbox's Postgres is a fresh 18 with no extensions installed, so an app
  that needs one will pass verification only if it installs it itself.
- No reviewer stage or step-level resumability. Terminal Workflows runs are
  reconciled.
- A failed run is final. Render Workflows does not retry `prompt-to-app`,
  because a retry starts the full pipeline again after the run is `failed`.
  The service and deploy waits and the Blueprint lookup do a failed Render
  read again, up to five attempts in sequence. A transient GitHub or Render
  API error in a different step still ends the run, for example in the clone.
  Call the API again for a new run, which starts from the beginning.

## Related

- [FAQ for field engineering](../FAQ.md) — live-demo talking points and quick answers

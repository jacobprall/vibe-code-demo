# Repository guide for agents

This file applies to the entire repository.

## What this is

`vibe-code-demo` turns one authenticated prompt into a deployed application on
Render. It is a reference architecture for wiring a vibe-coding product to
Render Workflows, Sandboxes, Blueprints, Postgres, and the Render MCP server —
optimized to be read, not to be a framework.

The path is: a caller POSTs a prompt, the gateway validates and dispatches it,
and a workflow designs the app against Render primitives, gathers openly
licensed imagery, and builds a storefront and an API in an isolated sandbox.
Then the `verify-app` subtask verifies them, and the `publish-app` subtask
copies them into a clone of the apps repository in a sandbox of its own, and
commits them with a Blueprint that Render deploys. A delete goes
the other way: `DELETE /v1/apps/:runId` claims every run of the run's app, and
the `delete-app` task runs one subtask for each step: it takes the app out of
the Blueprint, waits until no Blueprint sync can bring its Render resources
back, deletes them, and removes its files.

Two processes deploy independently:

- `app/server.ts` — Hono gateway web service.
- `app/host.ts` — Render Workflows host and task registration.

The gateway runs no models, holds no repository token, and creates or deletes
no infrastructure. Agents never write to GitHub and never call a Render write
API. Only `publish-app`, and the two steps of `delete-app` that push, write to
GitHub. The only Render write calls are the deletes in `app/teardown.ts`, and
only `delete-app-resources`, a step of the `delete-app` task, makes them.
Repository execution happens in a Render Sandbox. The sandbox that the agents
use holds only the app of the run: no clone of the apps repository, and no
credential. Each push clones the repository in a sandbox that no agent uses.

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
arrive at `POST /v1/apps`, runs are polled at `GET /v1/apps/:runId`, and
`DELETE /v1/apps/:runId` deletes the app of a run, with all of its runs. Local
workflow runs create real Render Sandboxes and deploy, and delete, real
services.

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
`main:render.yaml` with Auto Sync enabled, in the `RENDER_WORKSPACE_ID`
workspace: `findBlueprint` looks only there.

The gateway also serves a browser UI at `/`. It is protected by HTTP Basic
Auth (`UI_USERNAME` and `UI_PASSWORD`) and submits through `/ui/apps`, which
keeps `FACTORY_API_KEY` server-side. Do not expose a browser route that bypasses
this protection. The authenticated `UI_USERNAME` is a validated lowercase slug
and is injected as the app namespace; never accept a browser-supplied `user`.
`GET /ui/apps` lists only that namespace's runs, `DELETE /ui/apps/:runId`
deletes only a run in that namespace, and the UI restores selection from local
storage while treating Postgres as the source of truth.

## Repository map

Each concern is one file under `app/`. There are no barrels, no path aliases,
and no SDK layer — imports are relative with `.js` extensions (NodeNext).

The dependency direction is one-way:

```text
sandbox → tools → claude → agents → stages → workflow
```

The stages are `build`, `verify`, `publish`, `deploy`, and `delete`.
`workflow` runs them, `deploy` uses `build`, `verify`, and `publish`, `build`
uses `verify`, and `delete` uses `publish`. `policy` is imported by `claude`
and defines the MCP allowlist; `deploy` uses its `redactSecrets()` for the
logs of a failed deploy. `render` is imported by `claude` (for the MCP
URL), by `teardown`, and by `deploy` and `delete`. `blueprint`, `git`,
`images`, `teardown`, and `store` are used by `workflow` and the stages;
`teardown` uses `render` and `blueprint`; `gateway` uses `store`, `policy`,
and `contracts`. `contracts` is a leaf, and `config` uses only its `slug`
schema. Adding an edge that points backwards is a design smell.

```text
factory.config.ts   Directories, branch, plans, asset hosts, model tiers
app/
  config.ts      Environment parsing and per-process validation
  contracts.ts   Zod schemas for API input, agent output, and the stored spec
  gateway.ts     Bearer auth, body cap, dispatch, health, status
  agents.ts      The three agents, their prompts, and agentTask()
  claude.ts      The Agent type, runClaude(), md, agentJson
  tools.ts       Sandbox tools and the Tool contract
  policy.ts      checkToolCall, path rules, MCP allowlist, secret redaction
  sandbox.ts     Render Sandboxes, shellEscape, Postgres in the sandbox
  blueprint.ts   render.yaml generation — the only path that creates resources
  render.ts      REST reads of services, deploys, logs, Blueprints; HTTP probes
  teardown.ts    Deletes of a deleted app — the only Render write API calls
  git.ts         Clone, .gitignore, the copy of an app between sandboxes,
                 commit, push, verify, GitHub credentials
  store.ts       Postgres: one runs table
  templates.ts   Read a template and materialize it into the sandbox
  images.ts      Photographs from Wikimedia Commons for an app
  workflow.ts    The prompt-to-app and delete-app pipelines
  build.ts       The builder rounds with verify-app, and the builder message
  verify.ts      verify-app: build, boot, and query the app in the sandbox
  publish.ts     publish-app, and each clone, change, commit, and push
  deploy.ts      The deploy wait, the deploy repair, and the smoke checks
  delete.ts      The four steps of delete-app
  schema.sql     Schema, applied by scripts/migrate.ts
  server.ts      Gateway entrypoint
  host.ts        Workflows entrypoint
public/          Basic-Auth-protected prompt and deployment-status UI
templates/
  fullstack/     web/ (Vite + React + Tailwind + shadcn/ui), api/ (Hono + pg)
scripts/         migrate, doctor, demo, support
tests/           agents, blueprint, contracts, gateway, git, github-auth,
                 host, images, policy, render, shell, teardown, templates,
                 tools, workflow
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
- Write each free-form manifest value into a Blueprint with `yamlString`. One
  value that breaks the YAML stops the deploy of every app in the root
  Blueprint.
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
- No agent reads Render logs. `RENDER_READ_ONLY_TOOLS` has no log tool, so
  `checkToolCall` denies `list_logs` too. Logs can hold secrets, and the
  factory cannot redact what an agent reads. In a deploy repair round,
  workflow code reads the logs of each failed deploy with `fetchDeployLogs()`
  and gives them to the deploy manager in its input. The Render Dashboard
  shows each task input, so `failedDeployReport()` applies `redactSecrets()`
  first, and then cuts the logs to `MAX_DEPLOY_LOG_CHARS`. Do not cut first:
  a cut can divide a secret, and the redaction does not find a part of one.
- Only the builder gets sandbox tools.
- Every agent-supplied path is resolved against the workflow-owned `workDir`
 on `ToolContext`, which is the app directory, and must land inside it or
 `/tmp`. `checkToolCall` and the tool both check it. `sandbox__exec` always
 `cd`s there first: the exec API starts in `/`, so an unresolved relative path
 builds an application outside the app directory that no commit can ever see.
 These rules keep the file tools on one app, but they cannot limit a shell
 command. The next invariant does that.
- The sandbox that the agents and `verify-app` use holds only the app of the
  run. `initAppDir()` makes the app directory in a repository with no remote.
  No clone of the apps repository and no credential goes into that sandbox:
  the builder can run any command there, leave a process that runs, and change
  git itself.
- The image download in `app/images.ts` accepts HTTPS only, allowlisted hosts
  only, and `image/*` only, under the size cap. It writes only into the
  `assets/` directory of the app, under a name that it makes.
- `sandboxId` comes from workflow code, never from the model.
- The GitHub token never goes into a task input, because the Render Dashboard
  shows the input of every task run, and never into the sandbox of a build.
  `publish-app` reads the files of the app from that sandbox as data:
  `readAppFiles()` packs what a commit of the app directory holds, and accepts
  only regular files with plain paths below it, up to `MAX_APP_BYTES`. Then
  `publish-app` gets the token itself, and clones, writes the files, commits,
  and pushes in a sandbox that no agent uses.
- The clone checks out a symbolic link as a plain file (`core.symlinks=false`),
  so no write of the factory can follow a link that an earlier commit put in
  the repository.
- A commit changes only `apps/<user>/<app>/` and the root `render.yaml`.
  `commitPaths()` stages only these paths, and `pushVerified()` refuses a
  commit that changes a different path, before each attempt. This is true for
  `publish-app` and for the two steps of `delete-app` that push.
- The root Blueprint comes from the `factory.json` of each app in the clone of
  the push. `readAllSpecs()` accepts a spec only in the directory of the app
  that it names, so a file in one app directory cannot declare the resources
  of a different app.
- Infrastructure is created only by committing a Blueprint, and agents cannot
  publish: their sandbox has no clone and no token. The only Render write API
  calls are the deletes in
  `app/teardown.ts`, and only `delete-app-resources`, a step of `delete-app`,
  makes them. The gateway starts only `delete-app`, and `removeApp()` runs
  that step only after a push has taken the app out of the root Blueprint, and
  when `wait-for-blueprint-syncs` finds no sync of the Blueprint that waits or
  runs. They delete only a service or
  database in the app's own project whose name starts with the app's stem, and
  then the project, which Render deletes only when it is empty.
- A delete claims every run of one app, and `claimRunApp` claims an app name
  for a run. Both take the same Postgres advisory lock. So no run builds an app
  while a delete of it is in progress, and a delete is refused while a run of
  the app is running.
- Verification is workflow-owned. The `verify-app` subtask runs the same
  install, build, and pre-deploy commands the Blueprint gives Render, against
  a real Postgres running in the sandbox, and `publish-app` runs only after it
  passes. A health endpoint must answer with the database unreachable, because
  Render calls it before Postgres is ready; a `dataCheckPath` must return
  rows, because nothing else proves the schema was applied or the seed loaded.
- `node_modules/` and static-site build output are not committed.
  `appGitignore()` makes each app's `.gitignore` from its manifest:
  `node_modules/`, and each static site's publish directory below its
  `rootDir`, never the service directory itself. `verify()` writes it and deletes every ignored file before it
  builds, so it builds from the same files that Render's fresh clone gets.
- The push is verified against the remote SHA before the factory waits on a
  deploy.
- The sandbox is terminated in a `finally` block.
- Secret-shaped strings, including connection strings, are redacted from
  anything leaving the API.
- Render filesystems are ephemeral. Cross-process state goes in Postgres.

## Durability

There is no step memoization. A failed run is not resumed; the caller retries
by posting the prompt again. The gateway persists the Render task-run ID.
While a caller polls, it marks a run failed when its task run failed or was
canceled, so an interrupted task cannot leave a database row `running`
forever. A task that succeeds writes its result before it returns, so the
gateway does not read the result. Long service, deploy, and HTTP
waits heartbeat `progress`; keep those waits bounded.

Render Workflows does not retry a failed run either: `prompt-to-app` sets
`retry: { maxRetries: 0, waitDurationMs: 0 }` in place of the default three
retries. Each retry starts again at the architect with a new sandbox, and after
a push it can deploy a second app with a new name. The catch in `promptToApp`
sets the row to `failed` before the retry starts. Thus `claimRun` does not
count the retry, the gateway does not reconcile it, and its result can replace
a terminal status. Do not turn these retries on without resumability.

A transient fault is not a reason to retry the full run. Retry the one call
that failed, with a limit, as `pushVerified` does when another run pushed
first: the clone takes the new tip, and the change of the push runs again.
Each change of the factory is derived from its inputs, so it is never merged.
Agent subtasks keep the default retries: the parent waits for each one, so the
row stays `running` and inside the concurrency limit.

`verify-app` and `publish-app` set `maxRetries: 0`, so a failed one fails the
run. A retry of `publish-app` after its push finds nothing to commit, and the
run then ends as if the push changed no files. A retry of `verify-app` after a
timeout runs every build again, and a service that the failed attempt started
can still answer on the port of the next boot.

The service and deploy waits, and the `wait-for-blueprint-syncs` step of a
delete, read Render through `retryRead()` in `app/render.ts`. It does a failed
read again after the poll interval, and it fails after five failures in
sequence, with the last error. It fails at once for a 401 or 403, because a
new attempt cannot repair the API key. `findBlueprint` uses it too, so only a
lookup that finds no Blueprint gives `awaiting_blueprint`. `fetchDeployLogs`
uses it too, but when its reads cannot finish, it gives no logs and does not
fail the run: the logs are only diagnostic. Workflow code reads Render over
REST, which gives typed records. Only the agents use the Render MCP server.

Postgres enforces two things through constraints rather than application code:
`runs.idempotency_key` is unique, so a retried curl cannot start a second run,
and the conditional insert in `claimRun` caps concurrent runs at
`factoryConfig.maxConcurrentRuns`.

If you add resumability, `ctx.step()` from Render Workflows' Durability 2.0
API is the seam. Do not rebuild a checkpoint store here.

`delete-app` and each of its four steps set `maxRetries: 0`. A failed step
fails the delete. A failed delete marks the runs of the app `delete_failed`,
and the next `DELETE` starts the task again at the first step. Each step reads
the state that an earlier attempt left, so a new attempt does only what is
left. A delete that succeeds removes the rows. The gateway reconciles a
`deleting` row against the delete task in the same way as a `running` row.

Do not give the steps the default retries. A retry of
`remove-app-from-blueprint` after its push finds nothing to commit, so the
next step does not wait for the push event. A retry of
`wait-for-blueprint-syncs` gives a sync more time than `SYNC_TIMEOUT_MS`.

## Add an agent

1. Add it to `app/agents.ts`. `id`, `model`, and `prompt` are required; `id` is
   also the registered task name, so keep it unique and stable. Give it `tools`
   only if it needs the sandbox, and `renderTools` only from
   `RENDER_READ_ONLY_TOOLS`.
2. Wrap it with `agentTask()` at the bottom of `app/agents.ts`, beside the
   other registrations.
3. Call it from the stage that needs it, in `app/workflow.ts` or a stage
   module such as `app/build.ts`, with `tasks.run(<agent>Task, input)`.
   `tasks` is the `TaskContext` that Render Workflows gives to
   `prompt-to-app`; pass it to the stage. A task
   definition is not a function, so a direct call does not compile. Pass
   `sandboxId: sandbox.id` and `workDir: appDir` only when it declares tools.
   `runClaude()` refuses tools without both.
4. If it emits JSON, add a schema to `app/contracts.ts`, register it in
   `OUTPUT_SCHEMAS`, and call it through `agentJson()`, which retries once and
   then fails closed.
5. Update `tests/agents.test.ts` for tool access, and add the task name to
   `tests/host.test.ts` and `scripts/doctor.ts`.

## Add a Render primitive

1. Add the kind to `TIER_KINDS` in `app/contracts.ts`, and describe when to
   choose it in the architect's prompt.
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
5. Give `verify()` in `app/verify.ts` a way to exercise it before the push.
   A primitive nothing verifies is a primitive that fails in production.
6. Add assertions to `tests/blueprint.test.ts`. That suite is the contract for
   what gets deployed.
7. Make `deleteAppResources()` in `app/teardown.ts` list and delete it. A
   resource that the teardown does not know stays in the app's project, and
   Render then refuses to delete the project.

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
3. Update `templateLines()` in `app/build.ts` if the manifest it implies
   changes. `tests/templates.test.ts` pins the two together; that suite is what
   catches the template and the prompt drifting apart.
4. Templates are text only. They are materialized as one self-extracting shell
   script, so a binary file will not survive the trip.

## Change the pipeline

`app/workflow.ts` holds the two narratives: `prompt-to-app` and `delete-app`.
Keep them readable — a stage reads as one call there, with its detail in the
module of the stage. Fetch large state inside the workflow rather than passing
it through dispatch, and keep repeated execution safe: a rerun of the same
prompt replaces the app directory with the files of the new build, on the
newest tip of the branch.

Verification and the publish are subtasks of `prompt-to-app`, as the agents
are. `verify-app` gives its failures as a result, not as an error, and
`publish-app` gives the commit that it pushed, or null when no file changed.
Each one connects to the sandbox of the run by the `sandboxId` in its input,
and the parent terminates that sandbox. `publish-app` only reads the files of
the app from it. It clones, commits, and pushes in a sandbox of its own, and
terminates that sandbox itself. The last check of `verify-app` reads the files
as `publish-app` does, so the builder can fix what `publish-app` would refuse,
for example a symbolic link.

Do not give a credential to a sandbox that an agent uses, and do not push
from one. An agent can leave a process that runs, or a changed `git`, for the
next command that has the token.

Deployment progress distinguishes `waiting_for_services`,
`waiting_for_deploys`, and `smoke_testing`. Render reporting `live` is not
terminal: the public URL, data endpoint, and CORS checks must pass before the
run becomes `deployed`. The storefront check must also pass: the HTML of the
storefront, or a script that it loads, must contain the public hostname of the
API. The API checks cannot see the hostname that a browser uses.

When a deploy fails, the deploy manager diagnoses it from the logs of that
deploy, which workflow code gives it. `fetchDeployLogs()` reads them in the
time range of the deploy, with no type filter. Thus it gets the build logs,
the output of the pre-deploy command, and the logs of the new instance, and
no line of an earlier deploy. A type filter can lose the pre-deploy output,
because the Render documentation does not give its type. Each round reads
the deploy that failed in that round. Do not give an agent `list_logs` in
place of this read: an agent can read the logs of each service in the
workspace, and the factory cannot redact them first.

A deploy repair ships through the same path as the first build. The repaired
manifest must pass `verify-app`. Then `publish-app` rewrites `factory.json`
and both Blueprints before the commit, because Render gets the manifest only
through these files. A repair can change commands, paths, and env wiring, but
not the list from `declaredResources()`. Render does not delete a resource that leaves the
Blueprint, it cannot change the runtime of a service, and the loop watches only
the services of the first push. For this reason, the workflow fails such a
repair and pushes nothing.

Right after a push, the newest deploy of a service is still the deploy from
before the push. Render creates the new deploy only after the GitHub webhook
and the Blueprint sync. So a repair round waits only for the services that
failed, and gives each failed deploy to `waitForDeploy()` as `after`. A repair
that changes no files, or that starts no new deploy in `DEPLOY_TIMEOUT_MS`,
ends the run as `deploy_failed`. Do not send such a run to the smoke checks:
Render keeps the last live deploy of a failed service, so those checks can
pass on old code. Do not call `trigger_deploy` to start the deploy either;
only a commit deploys. `tests/workflow.test.ts` tests this loop.

Each `factory.json` records its `resourcePrefix`, which is in the name of each
Render resource of the app. Read the prefix from the spec, not from
`factoryConfig`, so that a new default does not rename the resources of an
existing app.

Helpers that outgrow the workflow file belong in a new `app/<concern>.ts`, not
in a subdirectory.

## Delete an app

A delete removes an app, not only a run: the runs of one app share its files
and its resources. `removeApp()` in `app/workflow.ts` runs one subtask for each
step, in this order. The steps are in `app/delete.ts`, and
`tests/workflow.test.ts` tests them:

1. `remove-app-from-blueprint`: write `deletedAt` into the app's
   `factory.json`, regenerate the root Blueprint, which leaves the app out,
   and push. Remove no source file yet: a commit that removes the files of a
   service starts a build of it, and that build fails.
2. `wait-for-blueprint-syncs`: wait a minute for the push event of an earlier
   push, and then until no sync of the Blueprint waits or runs. From the
   commit of step 1 on, the file does not declare the app, and a sync
   recreates only a declared resource. So only a sync of an earlier commit can
   bring a deleted resource back.
3. `delete-app-resources`: delete the app's services, then its databases, then
   its project. Its input is only the fields of the spec that name them.
4. `remove-app-files`: remove the app's directory and push.

Do not change this order. A resource that is deleted before step 1 comes back
on the next sync. The spec gives the names of the resources, so if step 4 comes
before step 3, a failed delete loses them. The files stay in the Git history.

Do not wait for the resources to leave the list of resources of the Blueprint.
A push that only removes resources starts no sync, and Render keeps them in
that list. The first version of the delete waited for that, and it never
finished.

The two steps that push each clone the apps repository in their own sandbox.
Their commits change only the app's directory and the root Blueprint, as the
commit of `publish-app` does. Keep task inputs and results small and
JSON-serializable: they go through Render, and the Dashboard shows them on the
run of each step.

Each step writes one JSON line to its logs for each thing that it changes or
waits for: the commits, the syncs that are not finished, and each resource
that it deletes or keeps. These logs are the record of what the factory
deleted, so keep them when you change a step.

## Checklist

1. Trust boundaries between gateway, workflow, and agents are preserved. No
   credential goes into a sandbox that an agent uses, and each commit changes
   only one app and the root Blueprint.
2. New agents are registered at the bottom of `app/agents.ts` and task names
   match between definition, dispatch, `doctor`, and tests.
3. New external input is validated and task values stay JSON-serializable.
4. Infrastructure is created through `app/blueprint.ts`, not an API call, and
   deleted only through `app/teardown.ts`.
5. Sandbox cleanup and repeated side effects are safe.
6. `.env.example`, `render.yaml`, `docs/README.md`, `README.md`, `AGENTS.md`,
   and `scripts/doctor.ts` updated if configuration changed.
7. Browser UI changes preserve Basic Auth and never serialize secrets.
8. `npm run check` passes.

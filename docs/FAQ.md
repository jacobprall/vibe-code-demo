# Vibe Code Demo — FAQ for Field Engineering & Dev Rel

Quick-reference for running the demo live, explaining the architecture, and
fielding questions about cost, safety, and product integration.

---

## What does this demo do?

A user types an app idea in plain English, for example "Build a website for a
local barbershop in San Jose". The factory designs, builds, verifies, and
deploys the app on Render, and no person touches the infrastructure. The
audience sees a prompt become a live URL in about 5 to 10 minutes.

The architect agent chooses the Render primitives from the prompt. A website
gets one static site. When the prompt asks for data that users write and the
app keeps, the app also gets a Node.js API and a Postgres database.

Architecture overview and how Render products fit together:
[README.md](../README.md#architecture-at-a-glance).

---

## How to run it live

### Before the demo

1. **One-time setup (already done for the shared demo workspace):**
   - Blueprint created in Dashboard pointing at the apps repo's `render.yaml`
   - Auto Sync enabled
   - All env vars set on gateway and workflow services

2. **Pre-flight check: run `npm run doctor`.** It checks the configuration,
   the apps repository, the Blueprint, the Render MCP server, Postgres, and
   the task registration. It is read-only, and it exits non-zero when a check
   fails.

3. **Rehearse one time.** Run the prompt of the demo end to end, and write
   down when each stage starts. Then delete that app. A live run that gets
   the same app name replaces the old app, and then Render has no new
   resource to create on stage.

4. **Keep a fallback.** Build one more app from a different prompt, and keep
   it deployed. If the live run fails or is slow, select the fallback run in
   the history of the UI.

5. **Before you go on stage:**
   - Sign in to the UI, so that the Basic Auth dialog is not on the projector.
   - Make sure that no other run is active. The cap of 3 runs applies to all
     users of the factory.

6. **Decide how to submit:**
   - **UI:** Open the gateway URL, sign in with `UI_USERNAME` / `UI_PASSWORD`, type a prompt
   - **CLI:** `npm run demo -- "Build a website for a local barbershop in San Jose"`
   - **API:** `curl -X POST -H "Authorization: Bearer $FACTORY_API_KEY" -d '{"prompt":"..."}' $GATEWAY_URL/v1/apps`

### Choose the prompt

- **A website** gets one static site. This run has the fewest steps, and
  Render deploys the site seconds after the push. Example: "Build a website
  for a local barbershop in San Jose".
- **An app that keeps data** also gets an API and a Postgres database. This
  run shows more of Render: a web service, Managed Postgres, `fromDatabase`
  and `fromService` wiring, the migrate-and-seed `preDeployCommand`, and the
  CORS check. It also takes longer. Name the data in the prompt, for example
  "Save the posts in a database.", and rehearse the prompt first.
- Use a kind of business, not the name of a real company. A site with the
  name of a real company is a fake site of that company.

### During the demo

- The UI shows these stages: Designing, Provisioning (only for an app with a
  database), Curating, Building, Verifying, Publishing, Waiting For Services,
  Waiting For Deploys, Smoke Testing, and Done.
- A typical run takes **5–10 minutes**. The builder takes the largest part.
- The CLI `npm run demo` follows the status endpoint and prints final URLs.
- If a run looks stuck, `GET /v1/apps/:runId` shows the current `stage` and `progress`.
- If your network stops, the run continues on Render. Reload the page, and
  the UI shows the same run again.

### What to say at each stage

| Stage | Who does the work | Say |
|---|---|---|
| Designing | `architect` agent | "The architect chooses the smallest set of Render primitives for the prompt. It can look at the workspace through read-only Render MCP tools, but it cannot create anything. It writes a plan, and workflow code turns the plan into a Blueprint." |
| Provisioning | Workflow code | "A real Postgres 18 starts in the sandbox, so the builder writes the schema and the seed data against a real database." |
| Curating | Workflow code | "The workflow finds openly licensed photographs on Wikimedia Commons and downloads them into the app. No model chooses a URL or a file name." |
| Building | `builder` agent | "The builder writes the app in a Render Sandbox. The sandbox holds only this app: no clone of the apps repository, and no GitHub token." |
| Verifying | `verify-app` task | "Workflow code builds the app from the files that a commit holds, as Render will. Then it boots the app and queries it." |
| Publishing | `publish-app` task | "A second, clean sandbox commits only this app's folder and the root Blueprint. Then it checks that GitHub has that commit." |
| Waiting For Services, Waiting For Deploys | Render | "Render's Blueprint sync creates the project and the services from the committed YAML, and deploys them." |
| Smoke Testing | Workflow code | "Render says that the app is live, but the run is not done. The workflow tests the public URLs, the API hostname in the storefront, the data, and CORS." |
| A deploy fails | `deploy-manager` agent | "The deploy manager reads the failed deploy through read-only Render MCP tools, and tells the builder what to fix. The fix goes through the same checks and the same commit." |

### After the demo

- Click **Visit live website**. It is a real app on Render, with real content.
- Open the app's project in the Render Dashboard. Its site, and its API and database when it has them, are grouped there.
- Show the apps repo on GitHub. Every app is a Git diff that you can review.
- Show the `render.yaml`. It is declarative infrastructure, not API calls.
- Point out that the generated app has its own `render.yaml`, and can graduate to a standalone Blueprint.
- Click **Delete app** to remove it: the app leaves the Blueprint, then Render deletes its services, database, and project, then its files leave the apps repo. On stage, delete a spare app, not the app that you just built.
- After the event, delete every demo app. An app with an API and a database costs about $14 a month until you delete it.

---

## What does it cost to run?

### Per-run costs (each demo execution)

| Cost center | Estimate | Notes |
|---|---|---|
| **Anthropic API** | ~$1–5 per run | 3 agents, all on Claude Sonnet. Builder is the biggest consumer (~80 turns max). |
| **Render Sandbox** | Included in Workflows | Billed as part of the Workflow task runtime. |
| **Workflow task time** | ~5–10 min on Standard plan | Standard plan tasks; billed per-second. |

### Standing costs (the factory itself)

| Resource | Plan | ~Monthly cost |
|---|---|---|
| Gateway web service | Starter | ~$7/mo |
| Factory Postgres | basic-256mb | ~$7/mo |
| Workflows service | Per-task billing | Varies with usage |

### Per-generated-app costs (these accumulate!)

| Resource | Plan | ~Monthly cost |
|---|---|---|
| Static site (storefront) | Free | $0 |
| API web service | Starter | ~$7/mo |
| Postgres | 0.1c-256mb | ~$7/mo |

> **⚠️ Generated apps keep running until you delete them.** Each demo run of
> an app that keeps data leaves a web service and a Postgres instance
> running. Budget ~$14/mo for each such app, and delete them after demos with
> **Delete app** in the UI or `DELETE /v1/apps/:runId`.

### Cost control levers

- `maxConcurrentRuns: 3` caps simultaneous runs (each consumes a Sandbox + model tokens)
- Every agent uses the `medium` model tier, `claude-sonnet-5`. The `large` tier, `claude-opus-5`, costs more, and no agent uses it by default. `factory.config.ts` sets both.
- Generated app plans (`starter`, `0.1c-256mb`) are the cheapest paid tiers

---

## Safety and trust boundaries

| Boundary | How it works |
|---|---|
| **No API writes to create** | Agents cannot call Render APIs to create or change resources. Only Blueprints committed to Git create them. The only API writes are the deletes of a deleted app, which workflow code makes after the app leaves the Blueprint. |
| **Sandbox isolation** | Agents run code only in a throwaway Sandbox that holds only the app of the run: no other user's app, and no GitHub token. No access to the host, other services, or production databases. |
| **Read-only MCP** | Architect and Deploy Manager get a strict allowlist of MCP tools — read-only inspection only. Enforced in code, not just prompts. |
| **No git for agents** | Agents cannot push. Workflow code copies the app's files into a clean sandbox, commits only that app's directory and the root Blueprint, pushes, and verifies the remote SHA. |
| **Tool-call gating** | `PreToolUse` hook blocks paths outside the app directory and every Render tool that is not read-only. It does not filter shell commands: the sandbox, which holds no credential, limits what a command can reach. |
| **Photographs from code** | Workflow code, not a model, downloads each photograph: HTTPS only, the two Wikimedia hosts only, images only, and up to 2 MB. It writes the file into the app's `assets/` directory, under a name that it makes. |
| **Secret separation** | Gateway never sees Anthropic key or GitHub credentials. Model-generated text is redacted for secret-shaped strings. |
| **Capability-based, not prompt-based** | Adding a new agent capability requires code changes to the tool allowlist — not a prompt edit. |

---

## Common questions

**Q: Can it build any app?**
A: Almost every app gets a static site. When the app keeps data, it also gets a Node.js API and Postgres. The supported primitives are `static_site`, `web_service`, and `postgres`. AGENTS.md shows how to add another, such as Key Value. The template for an app with an API is Vite + React + Tailwind + Hono + node-postgres.

**Q: What if the build fails?**
A: The workflow has a repair loop — up to 2 build-fix rounds with the builder. If it still fails, the run ends as `build_failed` with the failure reason. In the Render Dashboard, each verification is a `verify-app` run under the `prompt-to-app` run, with its failures in its result. The commit and push is a `publish-app` run.

**Q: What if the Render deploy fails?**
A: The Deploy Manager agent inspects the failure via MCP (reads logs, deploy status), diagnoses the issue, and hands it to the Builder for repair. Up to 2 deploy-repair rounds. After that it's `deploy_failed`. The workflow verifies each repair in the sandbox and writes its manifest back to `factory.json` and the Blueprints, so changed commands reach Render. After each repair push, it waits for a new deploy of each failed service. If a repair adds or removes a service or database, or changes the kind of a service, the run ends as `deploy_failed` with no push. If a repair changes no files, or Render starts no new deploy in 15 minutes, the run ends as `deploy_failed` at once.

**Q: What if a run gets stuck?**
A: Heartbeats and deadlines prevent silent hangs. If the task of a run failed or was canceled before it wrote its result, for example at a timeout, the next status poll marks the run failed and releases its concurrency slot. `GET /v1/apps/:runId` always shows the current stage.

**Q: How do I delete a generated app?**
A: Select one of its runs in the UI and click **Delete app**, or send `DELETE /v1/apps/:runId`. The delete removes the app with all of its runs. The workflow takes the app out of the root Blueprint, waits until no Blueprint sync can bring its resources back, deletes its services, database, and project, and then removes its files from the apps repo. It takes a few minutes. The files stay in the Git history. If it ends as `delete_failed`, the summary says why; fix that and delete again. In the Render Dashboard, each step is a run of its own under the `delete-app` run, with its own logs, so you can see which step failed.

**Q: Can multiple people demo at once?**
A: Yes, up to 3 concurrent runs (configurable). Each run gets its own sandbox and app namespace (`vibe-<user>-<app>-{web,api,db}`). Concurrent runs push to the same branch: a run whose push fails takes the new tip and makes its commit again.

**Q: Is this safe for public/untrusted users?**
A: No. It's a demonstration. Auth is HTTP Basic, there's no tenant isolation, no quotas, and no abuse controls. See [When to use this reference](README.md#when-to-use-this-reference) and [Current limitations](README.md#current-limitations).

**Q: How is this different from just using Claude to write code?**
A: Claude writes the code, but the factory is the system around it: isolated sandboxes, real database verification, declarative deployment, MCP-based failure diagnosis, durable state, and a deploy-repair loop. The code gets *built, migrated, booted, queried, committed, deployed, and smoke-tested* before anyone sees a URL.

**Q: Why Blueprints instead of the Render API?**
A: Three reasons: (1) env wiring is declarative — `fromDatabase` and `fromService` mean no connection strings in code, (2) every deploy is a Git diff, (3) agents physically cannot create infrastructure — the only path is a commit.

**Q: Does it use the Render MCP server?**
A: Yes, for the agents. The architect reads the workspace, and the deploy manager reads a failed deploy, through 10 read-only Render MCP tools. Workflow code reads services, deploys, and Blueprints over the REST API, which gives typed records.

**Q: Where do the photographs come from?**
A: From Wikimedia Commons, which holds only openly licensed files. Workflow code, not a model, searches for each subject in the plan (4 at most), selects a wide, high-resolution photograph, and downloads it into the app. The builder publishes the credit line of each photograph. A subject that finds nothing is left out, so a failure gives fewer photographs, not a failed run.

**Q: What models does it use?**
A: Configurable in `factory.config.ts`. Defaults: every agent uses `claude-sonnet-5`. There's a `large` tier (`claude-opus-5`) available but not used by default.

**Q: Does the generated app use the free tier?**
A: The static site is free. The API and the database do not use the free tier: free web services spin down after 15 minutes (bad for a demo), and a workspace gets only one free Postgres. Generated apps use the `starter` web service plan and `0.1c-256mb` Postgres plan — the cheapest paid options.

**Q: Where are the generated apps stored?**
A: In a GitHub repository (`APPS_REPO`). Structure: `apps/<user>/<app-slug>/`. Each app has its own `factory.json`, `render.yaml`, `README.md`, and `.gitignore`, plus the app source. `node_modules/` and each static site's build output are not committed: Render's build makes them.

**Q: Can I run it locally?**
A: Yes, `npm run dev:gateway` and `npm run dev:workflows` in separate terminals. But every run still creates a real Render Sandbox and can deploy real billable resources — local development changes *where orchestration runs*, not what it does.

---

## Key files to know

| File | What's in it |
|---|---|
| `factory.config.ts` | All the knobs: plans, region, models, asset policy, concurrency cap |
| `app/workflow.ts` | The two pipelines — start here. Each stage is a module: `build`, `verify`, `publish`, `deploy`, `delete` |
| `app/agents.ts` | Agent definitions, prompts, tool grants, model assignments |
| `app/images.ts` | Photographs from Wikimedia Commons: the search, the choice, and the checked download |
| `app/blueprint.ts` | How manifests become `render.yaml` files |
| `app/policy.ts` | Tool-call gating rules, path restrictions, MCP allowlist |
| `app/gateway.ts` | The public API and UI auth |
| `app/sandbox.ts` | Sandbox lifecycle, exec, Postgres setup |
| `app/store.ts` | Postgres-backed run state, idempotency, concurrency |
| `scripts/doctor.ts` | Pre-flight diagnostic — run before every demo |
| `render.yaml` | The factory's own Blueprint (gateway, Workflows service, and database in the `vibe-factory` project) |

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run doctor` fails | Missing or wrong env vars | Read the doctor output — it tells you exactly what's missing and how to fix it |
| Run stays at `awaiting_blueprint` | No Blueprint in the `RENDER_WORKSPACE_ID` workspace watches the apps repo | Create one in that workspace in Dashboard: New → Blueprint, pick the apps repo, branch `main`, path `render.yaml` |
| Run stays at `waiting_for_services` | Blueprint Auto Sync is off | Turn it on in Blueprint Settings |
| Deploy fails with port binding error | Generated app not binding to `0.0.0.0:$PORT` | This is a builder bug — the repair loop should catch it, but check the template |
| CORS errors in the deployed app | API not sending `Access-Control-Allow-Origin` | The builder prompt requires it; check the generated API code |
| The site has fewer photographs than subjects | Commons found nothing for a subject, or its download failed | Read the `image_skipped` lines in the logs of the `prompt-to-app` run |
| `too many concurrent runs` (429) | Hit the `maxConcurrentRuns` cap (default 3) | Wait for a run to finish, or increase the cap in `factory.config.ts` |

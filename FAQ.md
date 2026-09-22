# Vibe Code Demo — FAQ for Field Engineering & Dev Rel

Quick-reference for running the demo live, explaining the architecture, and
fielding questions about cost, safety, and product integration.

---

## What does this demo do?

A user types a plain-English app idea ("Create an online catalog for handcrafted
furniture"). The factory designs, builds, verifies, and deploys a working
multi-service application on Render — static site, API, and Postgres — without
any human touching infrastructure. The audience sees a prompt turn into a live
URL in roughly 5–10 minutes.

---

## Architecture at a glance

```
User → Gateway (web service) → Render Workflow → Sandbox
                                     ↓
                              Apps Repository (GitHub)
                                     ↓
                              Blueprint auto-sync → Deployed App
```

| Component | Render primitive | What it does |
|---|---|---|
| **Gateway** | Web Service (Docker) | Authenticates users, records runs in Postgres, dispatches workflow tasks. Holds no model keys or repo credentials. |
| **Factory DB** | Managed Postgres | Stores run state, idempotency keys, progress, concurrency claims. Enables reconnecting clients and stale-run recovery. |
| **Orchestrator** | Render Workflow | Runs the four-agent pipeline: Architect → Curator → Builder → Deploy Manager. Owns the Sandbox, model credentials, and GitHub push. |
| **Sandbox** | Render Sandbox | Isolated Linux environment where agents write code, install deps, run builds, boot services, and query a real Postgres — all throwaway. |
| **Apps Repository** | GitHub repo | Every generated app is committed here. The root `render.yaml` is the Blueprint Render watches. |
| **Generated App** | Static Site + Web Service + Postgres | The actual app that gets deployed. Blueprint sync creates these from the committed YAML. |

---

## How do the Render products come together?

1. **Web Services** — The gateway is a web service (Hono + Docker). Each generated app's API is also a web service, with health checks, `preDeployCommand` for migrations, and `fromDatabase` / `fromService` env-var wiring.

2. **Workflows** — The orchestration engine. One task (`prompt-to-app`) runs the entire pipeline: design, build, verify, publish, deploy, smoke-test. Sub-tasks (`architect`, `curator`, `builder`, `deploy-manager`) run as Claude agents with distinct tool grants and trust boundaries.

3. **Sandboxes** — Every run gets a fresh, isolated Linux sandbox. Agents execute code inside it, never on the host. Postgres 18 is installed on the fly inside the sandbox so the builder develops against a real database. The sandbox is terminated in a `finally` block.

4. **Postgres** — Two roles: (a) the factory's own `runs` table for durable state, and (b) a sandbox-local Postgres the generated app builds against. Generated apps also get their own Managed Postgres on Render.

5. **Blueprints** — The only write path to Render. Agents never call the Render API to create resources. The workflow writes `render.yaml`, commits to GitHub, and Render's Blueprint sync deploys everything. Every deployment is a Git diff.

6. **MCP** — Read-only Render MCP gives the Architect agent visibility into the workspace (existing services, databases) and gives the Deploy Manager logs and deploy status to diagnose failures. Strictly read-only — enforced by allowlist and `PreToolUse` hook.

---

## How to run it live

### Before the demo

1. **One-time setup (already done for the shared demo workspace):**
   - Blueprint created in Dashboard pointing at the apps repo's `render.yaml`
   - Auto Sync enabled
   - All env vars set on gateway and workflow services

2. **Pre-flight check — run `npm run doctor`:**
   - Verifies every credential, the GitHub repo, the Blueprint, MCP connectivity, Postgres, and task registration
   - Read-only; exits non-zero so you know immediately if something is broken

3. **Decide how to submit:**
   - **UI:** Open the gateway URL, sign in with `UI_USERNAME` / `UI_PASSWORD`, type a prompt
   - **CLI:** `npm run demo -- "Create an online catalog for handcrafted furniture"`
   - **API:** `curl -X POST -H "Authorization: Bearer $FACTORY_API_KEY" -d '{"prompt":"..."}' $GATEWAY_URL/v1/apps`

### During the demo

- The UI shows real-time stage progression: `designing → curating → building → verifying → publishing → deploying → smoke_testing → done`
- A typical full run takes **5–10 minutes**
- The CLI `npm run demo` follows the status endpoint and prints final URLs
- If a run looks stuck, `GET /v1/apps/:runId` shows the current `stage` and `progress`

### Talking points while it runs

- "The architect is reading the Render workspace right now through MCP"
- "The builder is writing code in a sandbox — an isolated Linux environment that gets destroyed after this run"
- "It's building, running migrations, booting the API, and querying it against a real Postgres — all inside the sandbox"
- "Now it's committing the Blueprint. Render will sync it and create the services"
- "It's watching the deploy via MCP and will smoke-test the live URLs"

### After the demo

- Click the deployed URL — it's a real app with real data
- Show the apps repo on GitHub — every app is a reviewable Git diff
- Show the `render.yaml` — it's declarative infrastructure, not API calls
- Point out the generated app has its own `render.yaml` and can graduate to a standalone Blueprint

---

## What does it cost to run?

### Per-run costs (each demo execution)

| Cost center | Estimate | Notes |
|---|---|---|
| **Anthropic API** | ~$1–5 per run | 4 agents; Architect and Builder use Claude Sonnet, Curator uses Haiku. Builder is the biggest consumer (~80 turns max). |
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

> **⚠️ Generated apps are never torn down automatically.** Every demo run
> leaves a web service and a Postgres instance running. Budget ~$14/mo per
> generated app, and delete them after demos. There is no teardown workflow.

### Cost control levers

- `maxConcurrentRuns: 3` caps simultaneous runs (each consumes a Sandbox + model tokens)
- Model tiers are configurable in `factory.config.ts` — swap `claude-opus-5` for `claude-sonnet-5` to save on the large tier
- Generated app plans (`starter`, `0.1c-256mb`) are the cheapest paid tiers

---

## Safety and trust boundaries

| Boundary | How it works |
|---|---|
| **No direct API writes** | Agents cannot call Render APIs to create/modify resources. Only Blueprints committed to Git. |
| **Sandbox isolation** | Agents run code only in a throwaway Sandbox. No access to the host, other services, or production databases. |
| **Read-only MCP** | Architect and Deploy Manager get a strict allowlist of MCP tools — read-only inspection only. Enforced in code, not just prompts. |
| **No git for agents** | Agents cannot push. Only workflow code commits and pushes, and verifies the remote SHA. |
| **Tool-call gating** | `PreToolUse` hook blocks destructive commands (`rm -rf`, `git push`, `DROP TABLE`), secret exfiltration, and paths outside the checkout. |
| **Secret separation** | Gateway never sees Anthropic key or GitHub credentials. Model-generated text is redacted for secret-shaped strings. |
| **Capability-based, not prompt-based** | Adding a new agent capability requires code changes to the tool allowlist — not a prompt edit. |

---

## Common questions

**Q: Can it build any app?**
A: It builds full-stack apps with a static site frontend, a Node.js API, and Postgres. The supported primitives are `static_site`, `web_service`, and `postgres`. `key_value` is defined in the schema but not wired — it's a deliberate extension point. The template is Vite + React + Tailwind + Hono + node-postgres.

**Q: What if the build fails?**
A: The workflow has a repair loop — up to 2 build-fix rounds with the builder. If it still fails, the run ends as `build_failed` with the failure reason.

**Q: What if the Render deploy fails?**
A: The Deploy Manager agent inspects the failure via MCP (reads logs, deploy status), diagnoses the issue, and hands it to the Builder for repair. Up to 2 deploy-repair rounds. After that it's `deploy_failed`.

**Q: What if a run gets stuck?**
A: The gateway reconciles stale runs by checking Workflows status. Heartbeats and deadlines prevent silent hangs. `GET /v1/apps/:runId` always shows the current stage.

**Q: Can multiple people demo at once?**
A: Yes, up to 3 concurrent runs (configurable). Each run gets its own sandbox and app namespace (`vibe-<user>-<app>-{web,api,db}`). Concurrent runs rebase onto the same branch.

**Q: Is this safe for public/untrusted users?**
A: No. It's a demonstration. Auth is HTTP Basic, there's no tenant isolation, no quotas, no abuse controls, and no teardown. See [docs/when-to-use.md](docs/when-to-use.md) and [docs/limitations.md](docs/limitations.md).

**Q: How is this different from just using Claude to write code?**
A: Claude writes the code, but the factory is the system around it: isolated sandboxes, real database verification, declarative deployment, MCP-based monitoring, durable state, and a deploy-repair loop. The code gets *built, migrated, booted, queried, committed, deployed, and smoke-tested* before anyone sees a URL.

**Q: Why Blueprints instead of the Render API?**
A: Three reasons: (1) env wiring is declarative — `fromDatabase` and `fromService` mean no connection strings in code, (2) every deploy is a Git diff, (3) agents physically cannot create infrastructure — the only path is a commit.

**Q: What models does it use?**
A: Configurable in `factory.config.ts`. Defaults: Architect and Builder use `claude-sonnet-5`, Curator uses `claude-haiku-4-5`. There's a `large` tier (`claude-opus-5`) available but not used by default.

**Q: Does the generated app use the free tier?**
A: No. Free web services spin down after 15 minutes (bad for a demo), and a workspace gets only one free Postgres. Generated apps use the `starter` web service plan and `0.1c-256mb` Postgres plan — the cheapest paid options.

**Q: Where are the generated apps stored?**
A: In a GitHub repository (`APPS_REPO`). Structure: `apps/<user>/<app-slug>/`. Each app has its own `factory.json`, `render.yaml`, `README.md`, plus the app source.

**Q: Can I run it locally?**
A: Yes, `npm run dev:gateway` and `npm run dev:workflows` in separate terminals. But every run still creates a real Render Sandbox and can deploy real billable resources — local development changes *where orchestration runs*, not what it does.

---

## Key files to know

| File | What's in it |
|---|---|
| `factory.config.ts` | All the knobs: plans, region, models, asset policy, concurrency cap |
| `app/workflow.ts` | The main pipeline — start here |
| `app/agents.ts` | Agent definitions, prompts, tool grants, model assignments |
| `app/blueprint.ts` | How manifests become `render.yaml` files |
| `app/policy.ts` | Tool-call gating rules, path restrictions, MCP allowlist |
| `app/gateway.ts` | The public API and UI auth |
| `app/sandbox.ts` | Sandbox lifecycle, exec, Postgres setup |
| `app/store.ts` | Postgres-backed run state, idempotency, concurrency |
| `scripts/doctor.ts` | Pre-flight diagnostic — run before every demo |
| `render.yaml` | The factory's own Blueprint (gateway + its database) |

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run doctor` fails | Missing or wrong env vars | Read the doctor output — it tells you exactly what's missing and how to fix it |
| Run stays at `awaiting_blueprint` | No Blueprint watching the apps repo | Create one in Dashboard: New → Blueprint, pick the apps repo, branch `main`, path `render.yaml` |
| Run stays at `waiting_for_services` | Blueprint Auto Sync is off | Turn it on in Blueprint Settings |
| Deploy fails with port binding error | Generated app not binding to `0.0.0.0:$PORT` | This is a builder bug — the repair loop should catch it, but check the template |
| CORS errors in the deployed app | API not sending `Access-Control-Allow-Origin` | The builder prompt requires it; check the generated API code |
| `too many concurrent runs` (429) | Hit the `maxConcurrentRuns` cap (default 3) | Wait for a run to finish, or increase the cap in `factory.config.ts` |

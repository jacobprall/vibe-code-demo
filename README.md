# vibe-code-demo

A reference for taking a natural-language app idea through generation,
verification, and a real Render deployment. It demonstrates how Workflows,
Sandboxes, Blueprints, Postgres, and read-only Render MCP access fit together in
a production-shaped agent system.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/vibe-code-demo)

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
| **Orchestrator** | Render Workflow | Runs the three-agent pipeline: Architect → Builder → Deploy Manager, with photographs from Wikimedia Commons between the first two. Owns the Sandbox, model credentials, and GitHub push. |
| **Sandbox** | Render Sandbox | Isolated Linux environment where agents write code, install deps, run builds, boot services, and query a real Postgres — all throwaway. |
| **Apps Repository** | GitHub repo | Every generated app is committed here. The root `render.yaml` is the Blueprint Render watches. |
| **Generated App** | Static Site + Web Service + Postgres | The actual app that gets deployed. Blueprint sync creates these from the committed YAML, in one Render project per app. |

## How the Render products come together

1. **Web Services** — The gateway is a web service (Hono + Docker). Each generated app's API is also a web service, with health checks, `preDeployCommand` for migrations, and `fromDatabase` / `fromService` env-var wiring.

2. **Workflows** — The orchestration engine. One task (`prompt-to-app`) runs the entire pipeline: design, build, verify, publish, deploy, smoke-test. Sub-tasks (`architect`, `builder`, `deploy-manager`) run as Claude agents with distinct tool grants and trust boundaries. Two more sub-tasks are workflow code: `verify-app` builds, migrates, boots, and queries the app in the sandbox, and `publish-app` generates the Blueprints, commits the app to GitHub, and pushes. A second task, `delete-app`, deletes an app in four sub-tasks, each with its own run and logs: `remove-app-from-blueprint` takes the app out of the Blueprint, `wait-for-blueprint-syncs` waits until no Blueprint sync can bring its Render resources back, `delete-app-resources` deletes them, and `remove-app-files` removes its files.

3. **Sandboxes** — Every run gets a fresh, isolated Linux sandbox. Agents execute code inside it, never on the host. It holds only the app of the run, with no clone of the apps repository and no GitHub token; each push clones the repository in a sandbox of its own. Postgres 18 is installed on the fly inside the sandbox so the builder develops against a real database. The sandbox is terminated in a `finally` block.

4. **Postgres** — Two roles: (a) the factory's own `runs` table for durable state, and (b) a sandbox-local Postgres the generated app builds against. Generated apps also get their own Managed Postgres on Render.

5. **Blueprints** — The only way the factory creates resources on Render. Agents never call the Render API. A Blueprint change never deletes a resource, so the `delete-app` task deletes a deleted app's resources with the API, after the app has left the Blueprint. The workflow writes `render.yaml`, commits to GitHub, and Render's Blueprint sync deploys everything. Every deployment is a Git diff.

6. **MCP** — Read-only Render MCP gives the Architect agent visibility into the workspace (existing services, databases) and gives the Deploy Manager logs and deploy status to diagnose failures. Strictly read-only — enforced by allowlist and `PreToolUse` hook.

## Quick start

```bash
npm ci
cp .env.example .env   # then fill it in
npm run dev:postgres
npm run db:migrate
```

In separate terminals:

```bash
npm run dev:gateway    # http://localhost:3000
npm run dev:workflows  # needs the authenticated Render CLI
```

Open `http://localhost:3000` and sign in with `UI_USERNAME` and `UI_PASSWORD`.
Or run `npm run demo -- "Your app idea"` against the gateway.

Full prerequisites, production deployment, and configuration are in
[docs/](docs/README.md). Agent and code conventions live in [AGENTS.md](AGENTS.md).

## License

MIT

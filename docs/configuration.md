# Configuration

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

Copy `.env.example` when setting up locally; see [Get started](getting-started.md) and [Deploy the factory](deployment.md).

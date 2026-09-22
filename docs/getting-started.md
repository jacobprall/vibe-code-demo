# Get started (local development)

## Prerequisites

- Node.js 22+ and Docker, for local Postgres
- The Render CLI, authenticated, and a workspace with Workflows and Sandboxes
- An Anthropic API key
- An empty GitHub repository for generated apps, and a credential that can push
  to it

## Install

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

See [Configuration](configuration.md) for environment variables and
[Deploy the factory](deployment.md) for production setup.

# vibe-code-demo

A reference for taking a natural-language app idea through generation,
verification, and a real Render deployment. It demonstrates how Workflows,
Sandboxes, Blueprints, Postgres, and read-only Render MCP access fit together in
a production-shaped agent system.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/vibe-code-demo)

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

# Deploy the factory

1. Create a Blueprint from this repository's `render.yaml`. It provisions the
   gateway and its Postgres database.
2. Set the unsynced gateway variables from [Configuration](configuration.md) and
   deploy once so the pre-deploy migration runs.
3. Create a **Workflow** service from the same repository. Blueprints do not
   create Workflow services; use `npm ci` to build and
   `npm run start:workflows` to start.
4. Set the Workflows variables from `.env.example`, using the database's
   internal connection string, then set the gateway's
   `RENDER_WORKFLOW_SLUG`.
5. Run `npm run doctor` before a demonstration to verify the cross-service
   wiring.

## Connect the generated-apps Blueprint once

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

See [The apps repository](apps-repository.md) for how generated apps are stored in `APPS_REPO`.

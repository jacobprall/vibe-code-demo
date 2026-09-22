# The apps repository

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

After [Deploy the factory](deployment.md), connect the apps repository Blueprint once so pushes deploy automatically.

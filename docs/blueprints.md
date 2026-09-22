# Why Blueprints are the write path

Nothing in this repository calls a Render API to create infrastructure. The
factory writes YAML, commits it, and Render syncs it. That design has three
useful consequences:

- **Env wiring is declarative.** `fromDatabase` puts `DATABASE_URL` on the API
  and `fromService` puts the API's hostname into the storefront's build. No
  code ever reads a connection string, so no connection string can leak
  through one.
- **Every deploy is reviewable.** Everything the factory has ever provisioned
  is a diff in the apps repository.
- **An agent cannot provision anything.** Not because we asked it not to, but
  because the only path to a new service is a commit, and agents do not run
  git.

MCP is how the factory *reads* Render — service state, deploy status, build
logs — and how the architect explores the workspace while it designs.

See [The apps repository](apps-repository.md) for how specs and Blueprints are laid out on disk.

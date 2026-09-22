# Run lifecycle

1. An authenticated UI or API request is claimed in Postgres and dispatched
   with a prompt, user namespace, and run ID.
2. A read-only architect chooses supported Render primitives and produces a
   plan; no infrastructure changes occur.
3. One sandbox receives the apps repository. A curator supplies constrained
   media and a builder creates the application from an empty directory or a
   contract-bearing template.
4. Workflow-owned checks build, migrate, boot, and query the generated
   services. Failures can return to the builder for bounded repair rounds.
5. Workflow code derives `factory.json` and `render.yaml`, commits, pushes,
   and verifies the remote SHA. Blueprint sync—not an agent API call—creates
   the infrastructure.
6. The workflow waits for deployment. On failure, a deploy manager uses
   read-only Render MCP data to diagnose the deploy and can request one bounded
   builder repair; live services still must pass public storefront, health,
   data, and CORS checks.
7. Postgres exposes progress and final URLs to reconnecting clients; a
   `finally` block terminates the sandbox.

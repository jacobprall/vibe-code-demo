# Production patterns demonstrated

- **Separate ingress from privileged execution.** The gateway authenticates,
  caps input, records durable status, and dispatches; the Workflows host owns
  models, source credentials, sandboxes, and deployment coordination. This
  narrows the public attack surface, at the cost of operating two services.
- **Declarative infrastructure as the only write path.** Agents cannot create
  Render resources. Workflow code turns a validated manifest into Blueprints,
  commits them, and lets Render sync the desired state. The result is
  reviewable and reproducible, but the initial Blueprint connection is manual
  and only modeled primitives can be deployed.
- **Capabilities instead of prompt-only restrictions.** The architect gets a
  read-only Render MCP allowlist, the curator can fetch only validated image
  assets, and the builder can edit a sandbox but cannot run Git. Adding a new
  capability requires code and policy work, which is deliberate friction.
- **Templates encode contracts, not the whole application.** Multi-service
  apps start with known API, CORS, migration, and environment-wiring seams;
  the model still controls product-specific behavior and presentation. This
  improves reliability while narrowing stack freedom.
- **Verify locally and against reality.** The workflow builds, migrates, boots,
  and queries services in the sandbox, then waits for Render and smoke-tests
  public URLs, database access, and CORS. This catches integration failures a
  build cannot, but increases run time and infrastructure consumption.
- **Durable progress with reconciliation.** Postgres holds run state,
  idempotency, heartbeats, task IDs, and concurrency claims so clients can
  reconnect and stale runs can be repaired. That operational reliability adds
  a database and state machine to what could otherwise be a short demo script.

See also [Run lifecycle](run-lifecycle.md) and [Why Blueprints are the write path](blueprints.md).

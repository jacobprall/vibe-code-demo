# Where to look in the code

- Start with `app/workflow.ts` for the control flow and `factory.config.ts` for
  configurable plans, limits, models, and asset policy.
- Read `app/blueprint.ts`, `app/contracts.ts`, and `app/templates.ts` together
  to see how model output becomes constrained deployable infrastructure.
- Read `app/claude.ts`, `app/tools.ts`, and `app/policy.ts` together to inspect
  the model-to-machine and model-to-Render trust boundaries.
- Read `app/gateway.ts` and `app/store.ts` for authentication, idempotency,
  progress, concurrency, and reconciliation.

For a presentation-sized system diagram and field-demo narrative, see
[FAQ for field engineering](../FAQ.md#architecture-at-a-glance).

Agent conventions and invariants are documented in [AGENTS.md](../AGENTS.md).

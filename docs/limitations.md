# Current limitations

- Every run, including one started from local development, consumes model
  tokens and a real Render Sandbox.
- Creating the Blueprint is manual, once, because Render has no API for it.
- One deployment is bound to one apps repository and one branch. Concurrent
  runs rebase onto that branch; the cap is three at a time.
- UI authentication and user slugs are demonstration conveniences, not
  tenant isolation, authorization, quotas, or abuse controls.
- Generated apps are never torn down. Every run leaves a web service, a static
  site, and a Postgres instance running, and they cost money until you delete
  them.
- Generated apps run on paid plans by default: free web services spin down
  after 15 minutes, and a workspace only gets one free Postgres.
- The sandbox's Postgres is a fresh 18 with no extensions installed, so an app
  that needs one will pass verification only if it installs it itself.
- `key_value` is in `TIER_KINDS` and nowhere else, so an architect that asks
  for one gets nothing and no warning.
- No reviewer stage, step-level resumability, or teardown workflow. Terminal
  Workflows runs are reconciled, but a failed task restarts from the beginning.
- A failed task run is not resumed; retry by calling the API again.

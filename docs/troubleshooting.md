# Troubleshooting a stuck run

`GET /v1/apps/:runId` returns both a coarse `stage` and a human-readable
`progress` value:

- `waiting_for_services`: Blueprint sync has not created every expected service.
- `waiting_for_deploys`: at least one Render deploy has not reached a terminal state.
- `smoke_testing`: deploys are live; public URL, data, or CORS checks are still running.
- `done`: the stored run is terminal.

All deploy and HTTP waits have deadlines and heartbeat the database. The
gateway also stores the Render task-run ID and periodically reconciles a
`running` row with Workflows. If the task succeeded, failed, or was canceled
without finalizing Postgres, the next status poll repairs the row and releases
its concurrency slot.

Run `npm run doctor` to verify factory and Blueprint wiring before debugging individual runs.

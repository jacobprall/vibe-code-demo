# When to use this reference

Use vibe-code-demo when:

- You want to see an agent produce and deploy a multi-service application
  rather than stop at generated code.
- You need to demonstrate declarative infrastructure as the controlled write
  path while agents inspect the platform through read-only MCP tools.
- The design needs both pre-deploy evidence and post-deploy proof across a
  frontend, API, database, and browser security boundary.

Do not use it unchanged for untrusted public users. The included gateway has
simple authentication, one apps repository and branch, a small concurrency
cap, no tenant-level quotas, and no teardown workflow.

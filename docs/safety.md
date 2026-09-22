# Safety boundaries

- The bearer token is compared in constant time, and the body is capped before
  it is parsed.
- The gateway never receives the GitHub credential or the Anthropic key.
- Claude's built-in `Bash`, `Read`, `Write`, and `Edit` are never granted;
  `runClaude` always passes `tools: []` for built-ins. Every action an agent
  takes goes through a workflow-owned sandbox tool.
- `preDeployCommand` is agent-authored and runs in the sandbox and again on
  Render, so it goes through the same destructive-command gate as the build
  and start commands before either happens.
- `checkToolCall` runs as a `PreToolUse` hook and vetoes destructive commands,
  secret exfiltration, paths outside the clone, and any Render MCP tool that is
  not on the read-only allowlist.
- Agents cannot run git, so they cannot publish; the trigger for a deploy is a
  commit only workflow code can make.
- `asset__fetch` accepts only HTTPS, only allowlisted hosts, only `image/*`
  responses under the size cap, and only destinations inside an `assets/`
  directory in the checkout.
- The push is verified against the remote SHA before the factory waits on a
  deploy, so Render is always building the commit that passed verification.
- Malformed structured model output fails closed after one repair attempt.
- Secret-shaped strings, including anything resembling a connection string, are
  redacted from API responses.
- The sandbox is terminated in a `finally` block.
- Postgres enforces idempotency and the concurrency cap through constraints
  rather than application code.

Implementation details and invariants for contributors are in [AGENTS.md](../AGENTS.md).

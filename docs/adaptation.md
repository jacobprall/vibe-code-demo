# Adaptation seams

- **Render primitives:** extend the manifest contract, Blueprint generator, and
  verification together. Keeping that path closed forces each resource type to
  be modeled deliberately instead of accepting arbitrary agent-authored YAML;
  the current `key_value` mismatch is called out under [limitations](limitations.md).
- **Agent roles:** add a task only when a distinct context or capability
  boundary is useful. Grant sandbox or Render tools explicitly and keep the
  allowlist test as the executable access review.
- **Templates:** add one when a target architecture has contracts the model
  should not rediscover on every run. Keep templates versioned and built in CI;
  the tradeoff is committing to a narrower stack.
- **External assets:** treat each new source as an egress-policy change, not
  just a search integration. Host, content type, size, and destination checks
  belong in the tool boundary.
- **Review:** this demo favors deterministic and deployed checks over model
  reviewers. For higher-risk generation, add review before publishing as
  `render-factory` does, accepting the extra latency and model cost.

See [AGENTS.md](../AGENTS.md) for checklists when adding agents, primitives, or pipeline stages.

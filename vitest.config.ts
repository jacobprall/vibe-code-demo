import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Vitest finds test files in dot directories too. Without this pattern,
		// it runs the tests of each Git worktree in .claude/worktrees/, which can
		// be on an old branch. Do not use `dir` for this. Vitest resolves `dir`
		// against the current directory, not the root, and the filter `tests/`
		// then finds no files.
		include: ["tests/**/*.test.ts"],
	},
});

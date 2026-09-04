/** Render Workflows host: registers every task, then waits for work. */
import { assertWorkflowEnv } from "./config.js";

assertWorkflowEnv();

// Agents must register before the workflow that calls them.
await import("./agents.js");
await import("./workflow.js");

console.log("airo factory workflows ready");

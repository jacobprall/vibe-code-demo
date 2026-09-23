/** Render Workflows host: registers every task, then waits for work. */
import { assertWorkflowEnv } from "./config.js";

assertWorkflowEnv();

// The SDK starts its task server on the next event-loop turn after the first
// task() call. One import evaluates workflow.js and agents.js in one pass, so
// every task registers before that. A task in a second import, or a top-level
// await in these modules, lets the server start first and leaves tasks out.
await import("./workflow.js");

console.log("vibe code factory workflows ready");

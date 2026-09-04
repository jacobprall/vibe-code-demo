/** Gateway process. */
import { serve } from "@hono/node-server";
import { assertGatewayEnv } from "./config.js";
import { createGateway } from "./gateway.js";

assertGatewayEnv();

const port = Number(process.env.PORT ?? 3000);
const server = serve({
	fetch: createGateway().fetch,
	hostname: "0.0.0.0",
	port,
});
console.log(`gateway listening on :${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => server.close(() => process.exit(0)));
}

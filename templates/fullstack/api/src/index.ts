import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db.js";

const app = new Hono();

// The storefront is a static site on a different onrender.com host, so every
// browser request to this API is cross-origin. Without this the response is
// dropped by the browser even though the server answered.
app.use("/*", cors());

/**
 * Render calls this before Postgres is reachable, so it must not query. A
 * health check that touches the database fails the deploy.
 */
app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/items", async (c) => {
	const { rows } = await db().query(
		`select id, slug, name, description, price_cents, image_path
		   from items
		  order by id`,
	);
	return c.json({ items: rows });
});

serve({
	fetch: app.fetch,
	hostname: "0.0.0.0",
	port: Number(process.env.PORT ?? 3000),
});

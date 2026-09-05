/**
 * Schema and seed, run by Render as the service's preDeployCommand — after
 * the build, before the start command, with DATABASE_URL already wired. It is
 * the only chance the app gets to create its schema.
 *
 * It runs on every deploy, including redeploys of an unchanged commit, so
 * every statement in both files has to be idempotent.
 */
import { readFile } from "node:fs/promises";
import { db } from "./db.js";

async function sql(name: string): Promise<string> {
	return readFile(new URL(`../sql/${name}`, import.meta.url), "utf8");
}

const pool = db();
for (const name of ["schema.sql", "seed.sql"]) {
	await pool.query(await sql(name));
	console.log(`applied ${name}`);
}
await pool.end();

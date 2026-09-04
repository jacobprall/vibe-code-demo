import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../app/store.js";

const schema = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"app",
	"schema.sql",
);

// The schema is idempotent, so applying it on every deploy is the migration.
await db().query(await readFile(schema, "utf8"));

await db().end();
console.log("applied app/schema.sql");

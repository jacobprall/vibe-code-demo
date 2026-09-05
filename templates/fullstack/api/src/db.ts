import pg from "pg";

let pool: pg.Pool | undefined;

/**
 * Render puts the database's internal connection string in DATABASE_URL via
 * `fromDatabase`, so nothing here ever reads a credential out of an API. The
 * internal network is already private; no SSL configuration is needed.
 */
export function db(): pg.Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error("DATABASE_URL is not set");
		pool = new pg.Pool({ connectionString, max: 5 });
	}
	return pool;
}

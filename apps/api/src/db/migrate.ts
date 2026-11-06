import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { loadConfig } from "../config.js";

// Resolved from this file (src/db or dist/db), so it works from any cwd.
const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * Applies pending SQL migrations from ./drizzle. Runs before the server starts
 * (see the `start` script), so deploys never serve a stale schema.
 */
export const runMigrations = async (databaseUrl: string) => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = loadConfig();
  await runMigrations(DATABASE_URL);
  console.log("Migrations applied");
}

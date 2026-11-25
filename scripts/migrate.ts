/**
 * Minimal SQL migration runner. Usage: `npm run migrate` (needs DATABASE_URL).
 *
 * How it works:
 *  - Every file in migrations/ named NNN_name.sql is a migration, applied in filename order.
 *  - Applied filenames are recorded in schema_migrations. A file already listed is skipped,
 *    which is why re-running is a no-op.
 *  - Each file runs in its own transaction together with its schema_migrations insert, so a
 *    failing migration leaves nothing half-applied and is not recorded.
 *  - A pg advisory lock stops two concurrent runs from applying the same file twice.
 *
 * Applied files must never be edited; add a new numbered file instead.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
const LOCK_ID = 7_041_001; // arbitrary constant, unique to this runner

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env or export it.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    // Clear message instead of a stack trace; the usual cause is Postgres not running.
    console.error(`Cannot connect to Postgres: ${(err as Error).message}`);
    console.error("Is it running? Try: docker compose up -d");
    process.exit(1);
  }

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const done = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const applied = new Set(done.rows.map((r) => r.filename));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`applied ${file}`);
      count++;
    }
    console.log(count === 0 ? "nothing to apply (up to date)" : `${String(count)} applied`);
  } finally {
    await client.end(); // closing the session also releases the advisory lock
  }
}

await main();

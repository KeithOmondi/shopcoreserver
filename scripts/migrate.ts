/**
 * Forward-only SQL migration runner.
 *  - Runs as a Kubernetes Job / Helm pre-upgrade hook, never from app pods.
 *  - Serialized across concurrent runners with a Postgres advisory lock.
 *  - Each migration runs in its own transaction, with a checksum recorded so an
 *    edited, already-applied migration is detected instead of silently diverging.
 *  - Zero-downtime rule: migrations must be backward compatible with the previous
 *    release (expand/contract). See docs/DEPLOYMENT.md.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const LOCK_ID = 727274001;

export async function migrate(databaseUrl: string, dir: string, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'shopcore-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== sum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      if (file.endsWith('.notx.sql')) {
        // Statements that cannot run inside a transaction (CREATE INDEX CONCURRENTLY). Must be idempotent
        // (use IF NOT EXISTS) because a failure part-way cannot be rolled back.
        await client.query("SET lock_timeout = '5s'");
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        applied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '5s'"); // never queue behind traffic indefinitely
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const dir =
    process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, '../migrations');
  migrate(url, dir)
    .then((a) => console.log(a.length ? `applied ${a.length} migration(s)` : 'schema up to date'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

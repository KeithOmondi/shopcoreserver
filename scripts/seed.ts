/**
 * Seeds a realistic catalog for local development and load testing.
 *   SEED_PRODUCTS=100000 SEED_STOCK=1000000 tsx scripts/seed.ts
 * Writes product ids to loadtest/data/product-ids.json for the load generators.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { uuidv7 } from '../src/infra/uuid.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const n = Number(process.env.SEED_PRODUCTS ?? 10_000);
  const stock = Number(process.env.SEED_STOCK ?? 1_000_000);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const ids: string[] = [];
  const batch = 5000;
  for (let off = 0; off < n; off += batch) {
    const size = Math.min(batch, n - off);
    const bIds = Array.from({ length: size }, () => uuidv7());
    ids.push(...bIds);
    const skus = bIds.map((_, i) => `SKU-${String(off + i).padStart(8, '0')}`);
    const names = skus.map((s) => `Product ${s}`);
    const prices = bIds.map(() => 100 + Math.floor(Math.random() * 99_900));
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO products (id, sku, name, description, price_cents, currency)
       SELECT id, sku, name, 'Seeded product for load testing', price, 'USD'
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[]) AS t(id, sku, name, price)
       ON CONFLICT (sku) DO NOTHING`,
      [bIds, skus, names, prices],
    );
    await client.query(
      `INSERT INTO inventory (product_id, available)
       SELECT p.id, $2 FROM products p WHERE p.id = ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
      [bIds, stock],
    );
    await client.query('COMMIT');
  }
  await client.query('ANALYZE');
  const { rows } = await client.query<{ id: string }>('SELECT id FROM products WHERE active ORDER BY id');
  await client.end();
  const out = path.resolve(process.cwd(), 'loadtest/data/product-ids.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(rows.map((r) => r.id)));
  console.log(`seeded; ${rows.length} active products; ids -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

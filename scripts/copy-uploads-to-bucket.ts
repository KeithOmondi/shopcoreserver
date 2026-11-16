/**
 * One-off: copies every file kept on local disk (UPLOAD_DIR) into the S3-compatible bucket.
 * Run once when you switch STORAGE_PROVIDER from disk to s3, with the S3_* settings filled in:
 *   npx tsx --env-file=.env.production scripts/copy-uploads-to-bucket.ts
 * It skips nothing silently: files missing on disk are listed at the end. Safe to run again (it overwrites with identical bytes).
 */
import pg from 'pg';
import { loadConfig } from '../src/config/index.js';
import { DiskStore } from '../src/modules/integrations/storage.js';
import { S3Store } from '../src/modules/integrations/s3-store.js';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const cfg = loadConfig(process.env, 'worker');
if (!cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) throw new Error('Fill in S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY first');
const disk = new DiskStore(cfg.UPLOAD_DIR);
const make = (b: string) => new S3Store({ bucket: b, region: cfg.S3_REGION, accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY!, endpoint: cfg.S3_ENDPOINT, prefix: cfg.S3_PREFIX });
const priv = make(cfg.S3_BUCKET);
const pub = cfg.S3_PUBLIC_BUCKET ? make(cfg.S3_PUBLIC_BUCKET) : priv;

async function main() {
  const db = new pg.Client({ connectionString: cfg.DATABASE_URL, ssl: cfg.DB_SSL ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const rows = (await db.query<{ id: string; content_type: string; kind: string }>('SELECT id, content_type, kind FROM uploads ORDER BY id')).rows;
  let copied = 0;
  const missing: string[] = [];
  for (const r of rows) {
    const ext = EXT[r.content_type];
    if (!ext) { missing.push(`${r.id} (unknown type ${r.content_type})`); continue; }
    try { await (r.kind === 'banner' || r.kind === 'product-image' ? pub : priv).put(r.id, ext, await disk.get(r.id, ext)); copied++; } catch { missing.push(r.id); }
  }
  await db.end();
  console.log(`Copied ${copied} of ${rows.length} files.`);
  if (missing.length) console.log(`Could not copy ${missing.length}:\n${missing.join('\n')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/index.js';
import type { Database } from '../../src/infra/db.js';
import { UploadService, type FileStore } from '../../src/modules/integrations/storage.js';

const memory = () => {
  const files = new Map<string, Buffer>();
  const store: FileStore = { put: async (id, ext, b) => { files.set(`${id}.${ext}`, b); }, get: async (id, ext) => files.get(`${id}.${ext}`)! };
  return { files, store };
};

describe('private and public buckets', () => {
  it('keeps shop pictures in the public bucket and everything else in the private one', async () => {
    const rows = new Map<string, { kind: string; owner_id: string; owner_type: string; content_type: string; file_name: string }>();
    const db = {
      tx: async (fn: (c: unknown) => unknown) => fn({ query: async (_sql: string, p: unknown[]) => { rows.set(String(p[0]), { kind: String(p[1]), owner_id: String(p[2]), owner_type: String(p[3]), content_type: String(p[4]), file_name: String(p[7]) }); return { rowCount: 1, rows: [] }; } }),
      read: async (fn: (c: unknown) => unknown) => fn({ query: async (_sql: string, p: unknown[]) => ({ rows: rows.has(String(p[0])) ? [rows.get(String(p[0]))] : [] }) }),
    } as unknown as Database;
    const priv = memory();
    const pub = memory();
    const svc = new UploadService(db, { UPLOAD_MAX_BYTES: 5_000_000 } as Config, priv.store, pub.store);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
    const owner = { id: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee01', type: 'staff' as const };
    const img = await svc.save(owner, 'product-image', 'image/jpeg', 'a.jpg', jpeg);
    const doc = await svc.save({ id: owner.id, type: 'rider' }, 'rider-document', 'image/jpeg', 'id.jpg', jpeg);
    expect(pub.files.size).toBe(1);
    expect(priv.files.size).toBe(1);
    expect([...pub.files.keys()][0]).toContain(img.id);
    expect([...priv.files.keys()][0]).toContain(doc.id);
    expect((await svc.open(img.id, null)).public).toBe(true);
    await expect(svc.open(doc.id, null)).rejects.toThrow();
    expect((await svc.open(doc.id, { id: owner.id, type: 'rider' })).bytes.length).toBe(jpeg.length);
  });
});

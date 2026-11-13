import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../infra/db.js';
import { ForbiddenError, NotFoundError, UnprocessableError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';

export const KINDS = ['rider-document', 'banner', 'return-photo', 'delivery-photo', 'avatar', 'product-image'] as const;
export const ProductImagesSchema = z.strictObject({ uploadIds: z.array(z.string().uuid()).max(10) });
export const UploadQuerySchema = z.object({ kind: z.enum(KINDS), name: z.string().trim().max(120).default('') });
export type UploadKind = (typeof KINDS)[number];
export type OwnerType = 'staff' | 'rider' | 'customer' | 'service';
export interface Owner { id: string; type: OwnerType }

/** Only these kinds of file are accepted, and the bytes must really be that kind (the label the sender gives isn't trusted). */
const TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
};
export const UPLOAD_CONTENT_TYPES = Object.keys(TYPES);
/** Documents may be PDFs; everything else is a picture. */
const allowed = (kind: UploadKind, ct: string) => (ct === 'application/pdf' ? kind === 'rider-document' : true);

export interface FileStore {
  put(id: string, ext: string, bytes: Buffer): Promise<void>;
  get(id: string, ext: string): Promise<Buffer>;
}
/** Local disk. In production point UPLOAD_DIR at a mounted volume; a bucket-backed store only has to provide the same two calls. */
export class DiskStore implements FileStore {
  constructor(private readonly dir: string) {}
  private path(id: string, ext: string) { return join(this.dir, id.slice(-2), `${id}.${ext}`); }
  async put(id: string, ext: string, bytes: Buffer) {
    await mkdir(join(this.dir, id.slice(-2)), { recursive: true });
    await writeFile(this.path(id, ext), bytes, { flag: 'wx' });
  }
  async get(id: string, ext: string) {
    try { return await readFile(this.path(id, ext)); } catch { throw new NotFoundError('File'); }
  }
}

export class UploadService {
  constructor(private readonly db: Database, private readonly cfg: Config, private readonly store: FileStore = new DiskStore(cfg.UPLOAD_DIR)) {}

  async save(owner: Owner, kind: UploadKind, contentType: string, name: string, bytes: Buffer) {
    const t = TYPES[contentType];
    if (!t) throw new UnprocessableError('FILE_TYPE', 'Upload a JPEG, PNG or WebP picture (or a PDF for rider documents)');
    if (!allowed(kind, contentType)) throw new UnprocessableError('FILE_TYPE', 'Only rider documents can be PDFs. Send a picture');
    if (!bytes.length) throw new UnprocessableError('FILE_EMPTY', 'That file is empty');
    if (bytes.length > this.cfg.UPLOAD_MAX_BYTES) throw new UnprocessableError('FILE_TOO_LARGE', `Files can be up to ${Math.floor(this.cfg.UPLOAD_MAX_BYTES / 1_000_000)} MB`, { maxBytes: this.cfg.UPLOAD_MAX_BYTES });
    if (!t.magic(bytes)) throw new UnprocessableError('FILE_CORRUPT', 'That doesn’t look like a real ' + t.ext.toUpperCase() + ' file');
    const id = uuidv7();
    const clean = name.replace(/[^\w .()-]/g, '').slice(0, 120) || `file.${t.ext}`;
    await this.store.put(id, t.ext, bytes);
    await this.db.tx((c) => c.query('INSERT INTO uploads (id, kind, owner_id, owner_type, content_type, size_bytes, sha256, file_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, kind, owner.id, owner.type, contentType, bytes.length, createHash('sha256').update(bytes).digest('hex'), clean]));
    return { id, url: `/v1/files/${id}`, kind, contentType, sizeBytes: bytes.length, name: clean };
  }

  /** The pictures a product shows, in order. Only pictures uploaded as product images can be used. */
  async setProductImages(productId: string, uploadIds: string[], actorId: string) {
    const ids = [...new Set(uploadIds)];
    await this.db.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM products WHERE id = $1', [productId])).rowCount) throw new NotFoundError('Product');
      const ok = (await c.query<{ id: string }>(`SELECT id FROM uploads WHERE id = ANY($1::uuid[]) AND kind = 'product-image'`, [ids])).rows.length;
      if (ok !== ids.length) throw new UnprocessableError('BAD_IMAGE', 'Some of those pictures weren’t uploaded as product images');
      await c.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
      for (const [i, u] of ids.entries()) await c.query('INSERT INTO product_images (product_id, upload_id, position) VALUES ($1,$2,$3)', [productId, u, i]);
      await c.query('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, data) VALUES ($1,$2,$3,$4,$5)', [actorId, 'product.images', 'product', productId, JSON.stringify({ count: ids.length })]);
    });
    return { productId, images: ids.map((u) => `/v1/files/${u}`) };
  }

  /** Banners are public; everything else is for the person who sent it and for staff. */
  async open(id: string, who: Owner | null) {
    if (!isUuid(id)) throw new NotFoundError('File');
    const r = (await this.db.read((c) => c.query<{ kind: string; owner_id: string; owner_type: string; content_type: string; file_name: string }>('SELECT kind, owner_id, owner_type, content_type, file_name FROM uploads WHERE id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundError('File');
    const isPublic = r.kind === 'banner' || r.kind === 'product-image';
    if (!isPublic && !(who && (who.type === 'staff' || who.type === 'service' || (who.id === r.owner_id && who.type === r.owner_type)))) throw new ForbiddenError('That file isn’t yours to open');
    return { bytes: await this.store.get(id, TYPES[r.content_type]!.ext), contentType: r.content_type, name: r.file_name, public: isPublic };
  }
}

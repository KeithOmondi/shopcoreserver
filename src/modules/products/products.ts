import { z } from 'zod';
import type { Logger } from 'pino';
import type { Database, Queryable } from '../../infra/db.js';
import type { ReadThroughCache } from '../../infra/cache.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../domain/errors.js';
import { isUuid, uuidv7 } from '../../infra/uuid.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductPage {
  items: Product[];
  nextCursor: string | null;
}

export const CreateProductSchema = z.strictObject({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  priceCents: z.number().int().min(0).max(1_000_000_000_00),
  currency: z.string().regex(/^[A-Z]{3}$/),
  initialStock: z.number().int().min(0).max(10_000_000).default(0),
});

export const UpdateProductSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    priceCents: z.number().int().min(0).max(1_000_000_000_00).optional(),
    active: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'at least one field is required');

export const AdjustStockSchema = z.strictObject({
  delta: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().trim().min(3).max(200),
});

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

const COLS = `id, sku, name, description, price_cents, currency, active, version, created_at, updated_at`;

interface Row {
  id: string;
  sku: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toProduct = (r: Row): Product => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  currency: r.currency,
  active: r.active,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export class ProductRepository {
  async findById(c: Queryable, id: string): Promise<Product | null> {
    const { rows } = await c.query<Row>(`SELECT ${COLS} FROM products WHERE id = $1`, [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async listActive(c: Queryable, limit: number, afterId?: string): Promise<Product[]> {
    const { rows } = afterId
      ? await c.query<Row>(`SELECT ${COLS} FROM products WHERE active AND id > $1 ORDER BY id LIMIT $2`, [afterId, limit])
      : await c.query<Row>(`SELECT ${COLS} FROM products WHERE active ORDER BY id LIMIT $1`, [limit]);
    return rows.map(toProduct);
  }

  async availability(c: Queryable, id: string): Promise<number | null> {
    const { rows } = await c.query<{ available: number }>('SELECT available FROM inventory WHERE product_id = $1', [id]);
    return rows[0]?.available ?? null;
  }
}

export interface Actor {
  id: string;
  requestId: string;
}

export class ProductService {
  constructor(
    private readonly db: Database,
    private readonly repo: ProductRepository,
    private readonly cache: ReadThroughCache<Product>,
    private readonly listCache: ReadThroughCache<ProductPage>,
    private readonly log: Logger,
  ) {}

  /**
   * Catalog reads are served from cache. Cached data is for display only: the order
   * path always re-reads price and stock inside its transaction, so staleness here
   * can never cause a wrong charge or an oversell.
   */
  async get(id: string): Promise<Product> {
    const p = await this.cache.get(id, () => this.db.read((c) => this.repo.findById(c, id)));
    if (!p || !p.active) throw new NotFoundError('Product');
    return p;
  }

  async list(limit: number, cursor?: string): Promise<ProductPage> {
    const after = cursor ? decodeCursor(cursor, 1)[0] : undefined;
    if (after !== undefined && !isUuid(after)) throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
    const key = `${limit}:${after ?? ''}`;
    const page = await this.listCache.get(key, async () => {
      const rows = await this.db.read((c) => this.repo.listActive(c, limit + 1, after));
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items, nextCursor: hasMore ? encodeCursor([items[items.length - 1]!.id]) : null };
    });
    return page!;
  }

  async availability(id: string): Promise<{ productId: string; available: number }> {
    const available = await this.db.read((c) => this.repo.availability(c, id));
    if (available === null) throw new NotFoundError('Product');
    return { productId: id, available };
  }

  async create(input: z.infer<typeof CreateProductSchema>, actor: Actor): Promise<Product> {
    const id = uuidv7();
    try {
      const product = await this.db.tx(async (c) => {
        const { rows } = await c.query<Row>(
          `INSERT INTO products (id, sku, name, description, price_cents, currency)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
          [id, input.sku, input.name, input.description, input.priceCents, input.currency],
        );
        await c.query('INSERT INTO inventory (product_id, available) VALUES ($1, $2)', [id, input.initialStock]);
        await audit(c, actor, 'product.create', 'product', id, input);
        await outbox(c, 'product', id, 'ProductCreated', toProduct(rows[0]!));
        return toProduct(rows[0]!);
      });
      await this.cache.invalidate(id);
      await this.listCache.flush();
      return product;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictError('SKU_EXISTS', 'SKU already exists');
      throw err;
    }
  }

  /** Optimistic concurrency: caller must send the version it read (If-Match). */
  async update(id: string, expectedVersion: number, patch: z.infer<typeof UpdateProductSchema>, actor: Actor) {
    const product = await this.db.tx(async (c) => {
      const { rows } = await c.query<Row>(
        `UPDATE products SET
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           price_cents = COALESCE($5, price_cents),
           active = COALESCE($6, active),
           version = version + 1,
           updated_at = now()
         WHERE id = $1 AND version = $2
         RETURNING ${COLS}`,
        [id, expectedVersion, patch.name ?? null, patch.description ?? null, patch.priceCents ?? null, patch.active ?? null],
      );
      if (!rows[0]) {
        const exists = await c.query('SELECT 1 FROM products WHERE id = $1', [id]);
        if (!exists.rowCount) throw new NotFoundError('Product');
        throw new ConflictError('VERSION_CONFLICT', 'Product was modified concurrently; re-read and retry');
      }
      await audit(c, actor, 'product.update', 'product', id, { expectedVersion, patch });
      await outbox(c, 'product', id, 'ProductUpdated', toProduct(rows[0]));
      return toProduct(rows[0]);
    });
    await this.cache.invalidate(id);
    await this.listCache.flush();
    return product;
  }

  async adjustStock(id: string, input: z.infer<typeof AdjustStockSchema>, actor: Actor) {
    return this.db.tx(async (c) => {
      const { rows } = await c.query<{ available: number }>(
        `UPDATE inventory SET available = available + $2, updated_at = now()
         WHERE product_id = $1 AND available + $2 >= 0 RETURNING available`,
        [id, input.delta],
      );
      if (!rows[0]) {
        const exists = await c.query('SELECT 1 FROM inventory WHERE product_id = $1', [id]);
        if (!exists.rowCount) throw new NotFoundError('Product');
        throw new UnprocessableError('NEGATIVE_STOCK', 'Adjustment would make stock negative');
      }
      await audit(c, actor, 'inventory.adjust', 'product', id, input);
      await outbox(c, 'inventory', id, 'StockAdjusted', { productId: id, ...input, available: rows[0].available });
      return { productId: id, available: rows[0].available };
    });
  }
}

export async function audit(c: Queryable, actor: Actor, action: string, type: string, id: string, data: unknown) {
  await c.query(
    'INSERT INTO audit_log (actor_id, action, entity_type, entity_id, data, request_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, action, type, id, JSON.stringify(data ?? {}), actor.requestId],
  );
}

export async function outbox(c: Queryable, aggregateType: string, aggregateId: string, eventType: string, payload: unknown) {
  await c.query('INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2,$3,$4)', [
    aggregateType,
    aggregateId,
    eventType,
    JSON.stringify(payload),
  ]);
}

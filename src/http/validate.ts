import { z, type ZodType } from 'zod';
import { ValidationError } from '../domain/errors.js';
import { isUuid } from '../infra/uuid.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  return r.data;
}

/**
 * A PATCH schema from a create schema: every field optional and, importantly, with its default removed.
 * (z.partial() keeps defaults, so an edit that sent one field would silently reset all the others.)
 */
export function patchOf<S extends z.ZodObject<z.ZodRawShape>>(schema: S) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) shape[k] = (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional();
  return z.strictObject(shape).refine((o) => Object.values(o).some((x) => x !== undefined), 'nothing to change') as unknown as z.ZodType<Partial<z.output<S>>>;
}

/** A true/false query-string flag. (z.coerce.boolean() would read the text "false" as true.) */
export const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const IdParam = z.object({ id: z.string().refine(isUuid, 'must be a UUID') });

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

export const IdParam = z.object({ id: z.string().refine(isUuid, 'must be a UUID') });

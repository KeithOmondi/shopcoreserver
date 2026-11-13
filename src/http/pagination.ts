import { ValidationError } from '../domain/errors.js';

/**
 * Opaque keyset cursors. Keyset (seek) pagination is O(log n) per page regardless
 * of depth, unlike OFFSET which scans and discards every skipped row.
 */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedParts: number): string[] {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parts) || parts.length !== expectedParts || !parts.every((p) => typeof p === 'string' && p.length < 100)) {
      throw new Error('bad shape');
    }
    return parts as string[];
  } catch {
    throw new ValidationError([{ path: ['cursor'], message: 'invalid cursor' }]);
  }
}

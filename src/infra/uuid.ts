import { createHash, randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random bits. Time-ordered keys
 * append to the right edge of B-tree indexes instead of scattering writes across
 * pages like UUIDv4, which keeps index inserts cheap and the buffer cache hot at
 * high write rates. A monotonic counter keeps ordering within the same millisecond.
 */
let lastMs = 0;
let seq = 0;

export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs++; // counter overflow: borrow the next millisecond
    now = lastMs;
  } else {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff; // random start leaves headroom
  }
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** Millisecond timestamp embedded in a UUIDv7, or null if `id` is not a v7 UUID. */
export function uuidv7Timestamp(id: string): number | null {
  if (!isUuid(id) || id[14] !== '7') return null;
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/** Stable, name-based UUID (SHA-256, RFC 9562 v8 layout) so external subject ids map to uuid columns. */
export function uuidFromName(namespace: string, name: string): string {
  const h = createHash('sha256').update(`${namespace}\0${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

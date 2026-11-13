import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const OPTS: ScryptOptions = { N, r: R, p: P, maxmem: 128 * 1024 * 1024 };

const derive = (password: string, salt: Buffer, opts: ScryptOptions, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password.normalize('NFKC'), salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));

/** `scrypt$N$r$p$salt$hash` so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, OPTS, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 }, want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash nobody knows the password to, so unknown emails cost the same time as wrong passwords. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(24).toString('base64')));

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '#@$%!';
const pick = (chars: string) => chars[randomInt(chars.length)]!;

/** One-time password: 12 characters with upper, lower, digit and symbol. Shown once, never stored in clear. */
export function temporaryPassword(): string {
  const rest = Array.from({ length: 8 }, () => pick(UPPER + LOWER + DIGIT));
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL), ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Returns a message when the password is not acceptable, otherwise null. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) return 'Mix upper and lower case letters.';
  if (!/\d/.test(password)) return 'Include a number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Include a symbol such as # or !.';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 3 && password.toLowerCase().includes(local)) return 'Don’t include your name or email.';
  return null;
}

/**
 * DEVELOPMENT / TEST / LOAD-TEST ONLY. Generates an Ed25519 key pair and mints JWTs
 * the API will accept, standing in for the real identity provider. Never deploy
 * the private key; production verifies against the IdP's JWKS (JWT_JWKS_URL).
 *
 *   tsx scripts/dev-keys.ts keys                 -> writes .dev-keys/{private,public}.pem
 *   tsx scripts/dev-keys.ts token <sub> [roles]  -> prints a JWT
 *   tsx scripts/dev-keys.ts tokens <n> <file>    -> writes n customer tokens (one per line) for load tests
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8 } from 'jose';

const DIR = path.resolve(process.cwd(), '.dev-keys');
const ISS = process.env.JWT_ISSUER ?? 'https://auth.dev.shopcore.local/';
const AUD = process.env.JWT_AUDIENCE ?? 'shopcore-api';

export async function generateKeys() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { publicPem: await exportSPKI(publicKey), privatePem: await exportPKCS8(privateKey) };
}

export async function mint(
  privatePem: string,
  sub: string,
  roles: string[],
  ttlSec = 3600,
  iss = ISS,
  aud = AUD,
  rolesClaim = 'roles',
) {
  const key = await importPKCS8(privatePem, 'EdDSA');
  return new SignJWT({ [rolesClaim]: roles })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'keys') {
    const { publicPem, privatePem } = await generateKeys();
    await mkdir(DIR, { recursive: true, mode: 0o700 });
    await writeFile(path.join(DIR, 'private.pem'), privatePem, { mode: 0o600 });
    await writeFile(path.join(DIR, 'public.pem'), publicPem);
    console.log(`wrote ${DIR}`);
    return;
  }
  const priv = await readFile(path.join(DIR, 'private.pem'), 'utf8');
  if (cmd === 'token') {
    console.log(await mint(priv, a ?? randomUUID(), (b ?? 'customer').split(',')));
  } else if (cmd === 'tokens') {
    const n = Number(a ?? 1000);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(await mint(priv, randomUUID(), ['customer'], 6 * 3600));
    await writeFile(b ?? 'tokens.txt', lines.join('\n'));
    console.log(`wrote ${n} tokens`);
  } else {
    console.error('usage: dev-keys.ts keys | token <sub> [roles] | tokens <n> <file>');
    process.exit(1);
  }
}

if (require.main === module) void main();

/**
 * Makes the signing keys a production server needs (an Ed25519 pair) and prints them ready to paste into your host's
 * environment settings. Nothing is written to disk. Run it once, keep the private key secret, and never run it again
 * on a live system: a new pair signs everyone out.
 *
 *   npm run prod:keys
 */
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

async function main() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  console.log('Copy these two into your host (Render > Environment). Keep the private key secret.\n');
  console.log('JWT_PUBLIC_KEY =');
  console.log((await exportSPKI(publicKey)).trim());
  console.log('\nSTAFF_JWT_PRIVATE_KEY =');
  console.log((await exportPKCS8(privateKey)).trim());
  console.log('\nThe same pair is used for staff, shoppers and riders. Paste each as a multi-line value, including the BEGIN and END lines.');
}
main().catch((e) => { console.error(e); process.exit(1); });

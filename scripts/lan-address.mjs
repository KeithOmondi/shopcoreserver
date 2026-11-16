/* global process, console, fetch, AbortSignal */
/**
 * Finds this computer's address on your Wi-Fi, so a real phone can reach the ShopCore server while you develop.
 * (On a phone, "localhost" is the phone itself.) Checks the server answers on that address and prints the line the
 * apps need. Nothing is changed unless you pass --write.
 *
 *   npm run lan                 show the address and the lines to use
 *   npm run lan -- --write      also set EXPO_PUBLIC_API_URL in ../app/.env and ../rider/.env
 *   npm run lan -- --clear      point both apps back at the emulator default (removes that line)
 *
 * Development only. For a real release, use your https server address instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = new Set(process.argv.slice(2));
const port = process.env.PORT ?? '8080';
const KEY = 'EXPO_PUBLIC_API_URL';

// Adapters that are never the Wi-Fi the phone is on: Docker, WSL, VMs, VPNs.
const VIRTUAL = /(vethernet|wsl|docker|virtualbox|vmware|vmnet|hyper-v|loopback|tailscale|zerotier|vpn|bluetooth|tap|tun)/i;
// 192.168.56.x is VirtualBox's default host-only network and 192.168.99.x is Docker Machine's: never your Wi-Fi.
const VIRTUAL_RANGE = /^192\.168\.(56|99)\./;
const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

const found = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const i of list ?? []) {
    if (i.family !== 'IPv4' || i.internal || !isPrivate(i.address)) continue;
    found.push({ name, address: i.address, virtual: VIRTUAL.test(name) || VIRTUAL_RANGE.test(i.address) });
  }
}
const real = found.filter((f) => !f.virtual);
// Prefer the adapter named Wi-Fi, then home-style 192.168.x.x addresses.
const score = (f) => (/wi-?fi|wlan|wireless/i.test(f.name) ? 2 : 0) + (f.address.startsWith('192.168.') ? 1 : 0);
const pick = [...real].sort((a, b) => score(b) - score(a))[0];

console.log('Addresses on this computer:');
for (const f of found) console.log(`  ${f.address.padEnd(16)} ${f.name}${f.virtual ? '   (virtual: not your Wi-Fi)' : ''}${f === pick ? '   <-- use this' : ''}`);

const files = [path.join(root, 'app', '.env'), path.join(root, 'rider', '.env')];

function setLine(file, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const keep = lines.filter((l) => !new RegExp(`^\\s*${KEY}=`).test(l));
  if (value) keep.unshift(`${KEY}=${value}`);
  fs.writeFileSync(file, keep.join('\n') + '\n');
}

if (args.has('--clear')) {
  for (const f of files) { if (fs.existsSync(f)) { setLine(f, null); console.log(`removed ${KEY} from ${path.relative(root, f)}`); } }
  console.log('Both apps now use the emulator default again (restart Metro with: npx expo start -c).');
  process.exit(0);
}

if (!pick) {
  console.log('\nNo Wi-Fi address found. Connect this computer to the same Wi-Fi as your phone and run it again.');
  process.exit(1);
}

const url = `http://${pick.address}:${port}`;
console.log(`\nThe apps should use:\n  ${KEY}=${url}\n`);

try {
  const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(4000) });
  console.log(res.ok ? `Server answers at ${url} (health check ${res.status}).` : `Server answered ${res.status} at ${url}. Is it fully started?`);
} catch {
  console.log(`Nothing answered at ${url}. Start the server (npm run dev in server) and check Windows Firewall allows port ${port} on private networks.`);
}

if (args.has('--write')) {
  for (const f of files) { setLine(f, url); console.log(`set ${KEY} in ${path.relative(root, f)}`); }
  console.log('\nNow restart Metro with a cleared cache so the apps pick it up:  npx expo start --dev-client -c');
} else {
  console.log(`\nTo write it into both apps' .env files:  npm run lan -- --write`);
}
console.log(`\nOn the phone, open ${url}/health/ready in its browser. If it says ok, the app can connect too.`);

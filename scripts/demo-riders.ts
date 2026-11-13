/**
 * DEVELOPMENT ONLY. Creates the delivery zones from the admin designs and a few approved demo riders.
 *
 *   npm run demo:riders          riders sign in with their phone and the password Ride1234
 *
 * Safe to run twice: existing zones and riders are left alone.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { uuidv7 } from '../src/infra/uuid.js';
import { hashPassword } from '../src/modules/staff/password.js';
import { ZonesService } from '../src/modules/dispatch/zones.js';

const ZONES: [string, number, number, string[]][] = [
  ['Kilimani', 250, 20, ['Kilimani', 'Kileleshwa', 'Hurlingham', 'Upper Hill', 'Lavington']],
  ['Westlands', 300, 20, ['Westlands', 'Parklands', 'Ruaka']],
  ['CBD', 200, 20, ['CBD', 'Ngara', 'Eastleigh']],
  ['Karen', 450, 22, ['Karen', 'Lang’ata', 'Ngong Road']],
  ['Ruiru', 500, 25, ['Ruiru']],
];
const RIDERS: [string, string, string, string, string][] = [
  ['James Mutua', '+254712345001', 'Motorbike', 'KDA 284G', 'Westlands'], ['Grace Wambui', '+254712345002', 'Motorbike', 'KMC 190B', 'Kilimani'],
  ['David Kariuki', '+254712345003', 'Motorbike', 'KMF 771K', 'Westlands'], ['Faith Njeri', '+254712345004', 'Motorbike', 'KMD 305L', 'Kilimani'],
  ['Brian Otieno', '+254712345005', 'Bicycle', '', 'CBD'], ['Miriam Kilonzo', '+254712345006', 'Motorbike', 'KMG 618C', 'Karen'],
];

async function main() {
  const cfg = loadConfig({ ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' }, 'worker');
  if (cfg.NODE_ENV === 'production') throw new Error('Demo riders can’t be created in production');
  const db = new Database(cfg, createLogger({ level: 'warn', service: 'demo-riders' }));
  const actor = { id: 'system', name: 'Demo seed', requestId: 'demo-riders' };
  const zones = new ZonesService(db);
  try {
    const existing = new Map((await zones.list()).items.map((z) => [z.name, z.id]));
    for (const [name, fee, commission, areas] of ZONES) {
      if (!existing.has(name)) existing.set(name, (await zones.create({ name, feeCents: fee * 100, commissionPct: commission, areas, note: '', active: true }, actor)).id);
    }
    await zones.saveSettings({ baseFeeCents: 300 * 100, minBasketCents: 0 }, actor);
    const hash = await hashPassword('Ride1234');
    let made = 0;
    for (const [name, phone, vehicle, plate, zone] of RIDERS) {
      const id = uuidv7();
      const ok = await db.tx(async (c) => {
        const r = await c.query(`INSERT INTO riders (id, phone, name, vehicle, plate, zone_id, password_hash, account_status, welcomed, rating, deliveries_done, reviewed_by, reviewed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',true,4.8,0,'Demo seed',now()) ON CONFLICT (phone) DO NOTHING`, [id, phone, name, vehicle, plate, existing.get(zone)!, hash]);
        if (!r.rowCount) return false;
        for (const key of ['id', 'license', 'insurance', 'photo', 'selfie']) await c.query(`INSERT INTO rider_docs (rider_id, key, state, expires_on, note) VALUES ($1,$2,'valid', current_date + 300, '')`, [id, key]);
        return true;
      });
      if (ok) made++;
    }
    console.log(`Zones ready (${existing.size}); ${made} demo rider(s) added. Riders sign in with their phone and Ride1234.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

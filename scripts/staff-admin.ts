/**
 * Creates the first staff accounts. Run once per environment.
 *
 *   tsx --env-file=.env scripts/staff-admin.ts bootstrap "Amara Mwangi" amara@shopcore.co
 *       Creates the owner (only if there are no staff yet) and prints a one-time password.
 *       The owner must choose their own password at first sign-in.
 *
 *   tsx --env-file=.env scripts/staff-admin.ts demo
 *       DEVELOPMENT ONLY. Creates the 18-person demo team used by the admin app's screens,
 *       all with the password in DEMO_PASSWORD (default ShopCore#2025). Refuses to run in production.
 */
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/infra/logger.js';
import { Database } from '../src/infra/db.js';
import { StaffService } from '../src/modules/staff/staff.js';

const DEMO: [string, string, 'active' | 'invited', string, string][] = [
  ['Amara Mwangi', 'Owner admin', 'active', 'amara', '+254 712 555 101'],
  ['James Mutua', 'Operations manager', 'active', 'james', '+254 712 555 102'],
  ['Grace Wambui', 'Customer support', 'active', 'grace', '+254 712 555 103'],
  ['David Kariuki', 'Finance analyst', 'invited', 'david', '+254 712 555 106'],
  ['Faith Njeri', 'Rider manager', 'active', 'faith', '+254 712 555 104'],
  ['Peter Otieno', 'Dispatch manager', 'active', 'peter', '+254 712 555 107'],
  ['Lucy Achieng', 'Customer support', 'active', 'lucy', '+254 712 555 108'],
  ['Samuel Kimani', 'Finance analyst', 'active', 'samuel', '+254 712 555 109'],
  ['Esther Chebet', 'Customer support', 'active', 'esther', '+254 712 555 110'],
  ['Daniel Ochieng', 'Rider manager', 'active', 'daniel', '+254 712 555 111'],
  ['Mercy Wairimu', 'Customer support', 'active', 'mercy', '+254 712 555 112'],
  ['Brian Mwenda', 'IT support', 'active', 'brian', '+254 712 555 113'],
  ['Joy Naliaka', 'Finance analyst', 'invited', 'joy', '+254 712 555 114'],
  ['Ibrahim Yusuf', 'Rider manager', 'active', 'ibrahim', '+254 712 555 115'],
  ['Ruth Njoki', 'Marketing manager', 'active', 'ruth', '+254 712 555 116'],
  ['Kevin Oloo', 'Inventory manager', 'active', 'kevin', '+254 712 555 117'],
  ['Sarah Wekesa', 'Warehouse lead', 'active', 'sarah', '+254 712 555 118'],
  ['Dennis Kibet', 'Purchasing agent', 'active', 'dennis', '+254 712 555 119'],
];

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const env = { ...process.env, JWT_ISSUER: process.env.JWT_ISSUER ?? 'x', JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'x', JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? 'x' };
  const cfg = loadConfig(env, 'worker');
  const log = createLogger({ level: 'warn', service: 'staff-admin' });
  const db = new Database(cfg, log);
  const staff = new StaffService(db, cfg, log);
  try {
    if (cmd === 'bootstrap') {
      if (!a || !b) throw new Error('usage: staff-admin.ts bootstrap "<name>" <email>');
      const temp = await staff.bootstrapOwner(a, b);
      console.log(temp ? `Owner created: ${b}\nOne-time password: ${temp}\n(They must choose their own at first sign-in.)` : 'Staff already exist; nothing created.');
    } else if (cmd === 'demo') {
      if (cfg.NODE_ENV === 'production') throw new Error('The demo team can’t be created in production');
      const pw = process.env.DEMO_PASSWORD ?? 'ShopCore#2025';
      await staff.ensureDefaultRoles();
      for (const [name, role, status, handle, phone] of DEMO) {
        await staff.insertRaw({ name, email: `${handle}@shopcore.co`, phone, role, status, password: pw, mustChange: status === 'invited' });
      }
      console.log(`Demo team ready (${DEMO.length} people). Password: ${pw}`);
    } else {
      throw new Error('usage: staff-admin.ts bootstrap "<name>" <email> | demo');
    }
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

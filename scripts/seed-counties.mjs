// Adds a delivery zone for every Kenyan county (except Nairobi, which has its own zones), so customers can pick any county.
// Safe to run again: a county that already has a zone is left alone. Fees are starting points; change them in Admin > Delivery zones.
//   node scripts/seed-counties.mjs <postgres url>
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/seed-counties.mjs <postgres url>'); process.exit(1); }

// [county, fee in KES, main towns]
const NEAR = 500, MID = 800, FAR = 1000, REMOTE = 1500;
const COUNTIES = [
  ['Kiambu', NEAR, ['Kiambu', 'Thika', 'Kikuyu', 'Limuru', 'Juja', 'Githunguri']],
  ['Kajiado', NEAR, ['Kitengela', 'Ngong', 'Ongata Rongai', 'Kajiado', 'Kiserian']],
  ['Machakos', NEAR, ['Machakos', 'Athi River', 'Syokimau', 'Mlolongo', 'Kangundo']],
  ['Murang’a', NEAR, ['Murang’a', 'Kenol', 'Maragua', 'Kangari']],
  ['Nakuru', MID, ['Nakuru', 'Naivasha', 'Gilgil', 'Molo', 'Njoro']],
  ['Nyeri', MID, ['Nyeri', 'Karatina', 'Othaya', 'Mukurweini']],
  ['Kirinyaga', MID, ['Kerugoya', 'Kutus', 'Sagana', 'Wanguru']],
  ['Embu', MID, ['Embu', 'Runyenjes', 'Siakago']],
  ['Laikipia', MID, ['Nanyuki', 'Nyahururu', 'Rumuruti']],
  ['Nyandarua', MID, ['Ol Kalou', 'Ndaragwa', 'Engineer']],
  ['Makueni', MID, ['Wote', 'Emali', 'Makindu', 'Sultan Hamud']],
  ['Kitui', MID, ['Kitui', 'Mwingi', 'Mutomo']],
  ['Narok', MID, ['Narok', 'Kilgoris', 'Ololulunga']],
  ['Kericho', MID, ['Kericho', 'Litein', 'Londiani']],
  ['Bomet', MID, ['Bomet', 'Sotik']],
  ['Meru', MID, ['Meru', 'Maua', 'Nkubu']],
  ['Tharaka-Nithi', FAR, ['Chuka', 'Marimanti']],
  ['Nandi', FAR, ['Kapsabet', 'Nandi Hills', 'Mosoriot']],
  ['Uasin Gishu', FAR, ['Eldoret', 'Moiben', 'Burnt Forest']],
  ['Trans Nzoia', FAR, ['Kitale', 'Endebess']],
  ['Elgeyo-Marakwet', FAR, ['Iten', 'Kapsowar']],
  ['Baringo', FAR, ['Kabarnet', 'Eldama Ravine', 'Marigat']],
  ['Kakamega', FAR, ['Kakamega', 'Mumias', 'Malava', 'Butere']],
  ['Bungoma', FAR, ['Bungoma', 'Webuye', 'Kimilili']],
  ['Busia', FAR, ['Busia', 'Malaba', 'Nambale']],
  ['Vihiga', FAR, ['Mbale', 'Luanda', 'Hamisi']],
  ['Kisumu', FAR, ['Kisumu', 'Ahero', 'Maseno', 'Muhoroni']],
  ['Siaya', FAR, ['Siaya', 'Bondo', 'Ugunja']],
  ['Homa Bay', FAR, ['Homa Bay', 'Mbita', 'Oyugis']],
  ['Migori', FAR, ['Migori', 'Rongo', 'Awendo', 'Isebania']],
  ['Kisii', FAR, ['Kisii', 'Suneka', 'Ogembo']],
  ['Nyamira', FAR, ['Nyamira', 'Keroka']],
  ['Mombasa', FAR, ['Mombasa', 'Nyali', 'Bamburi', 'Likoni', 'Mtwapa']],
  ['Kilifi', FAR, ['Kilifi', 'Malindi', 'Watamu', 'Mariakani']],
  ['Kwale', FAR, ['Ukunda', 'Diani', 'Kwale', 'Msambweni']],
  ['Taita-Taveta', FAR, ['Voi', 'Taveta', 'Wundanyi']],
  ['Tana River', REMOTE, ['Hola', 'Garsen']],
  ['Lamu', REMOTE, ['Lamu', 'Mpeketoni']],
  ['Garissa', REMOTE, ['Garissa', 'Dadaab']],
  ['Wajir', REMOTE, ['Wajir']],
  ['Mandera', REMOTE, ['Mandera']],
  ['Marsabit', REMOTE, ['Marsabit', 'Moyale']],
  ['Isiolo', REMOTE, ['Isiolo']],
  ['Samburu', REMOTE, ['Maralal']],
  ['Turkana', REMOTE, ['Lodwar', 'Kakuma']],
  ['West Pokot', REMOTE, ['Kapenguria', 'Makutano']],
]

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('BEGIN');
  const have = new Set((await c.query('SELECT lower(county) AS c FROM zones')).rows.map((r) => r.c));
  const names = new Set((await c.query('SELECT lower(name) AS n FROM zones')).rows.map((r) => r.n));
  let order = Number((await c.query('SELECT COALESCE(max(sort_order), 0) AS m FROM zones')).rows[0].m);
  let added = 0;
  for (const [county, kes, areas] of COUNTIES) {
    if (have.has(county.toLowerCase()) || names.has(county.toLowerCase())) continue;
    order += 1;
    await c.query('INSERT INTO zones (id, name, county, fee_cents, commission_pct, areas, note, active, sort_order) VALUES ($1,$2,$3,$4,20,$5,$6,true,$7)',
      [randomUUID(), county, county, kes * 100, areas, 'Starting fee: set the real price for this county.', order]);
    added += 1;
  }
  await c.query('COMMIT');
  console.log(`Added ${added} counties. ${(await c.query('SELECT count(DISTINCT county) AS n FROM zones')).rows[0].n} counties now have delivery.`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await c.end();
}

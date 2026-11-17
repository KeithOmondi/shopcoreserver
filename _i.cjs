const {Client}=require('pg');const fs=require('fs');
const env=Object.fromEntries(fs.readFileSync('.env.render','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/\s+#.*$/,'')]}));
(async()=>{const c=new Client({connectionString:env.DATABASE_MIGRATION_URL||env.DATABASE_URL});await c.connect();
console.log((await c.query(`select o.id,o.number,o.status,o.total_cents,o.created_at,(select string_agg(p.sku,',') from order_items i join products p on p.id=i.product_id where i.order_id=o.id) skus from orders o order by created_at`)).rows);
console.log((await c.query(`select tgname,tgrelid::regclass t from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('stock_movements','orders','order_items','inventory')`)).rows);
const refs=(await c.query(`select conrelid::regclass t, a.attname col from pg_constraint k join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey) where k.contype='f' and k.confrelid in ('orders'::regclass,'order_items'::regclass) order by 1`)).rows;
for(const r of refs){const n=(await c.query(`select count(*) from ${r.t}`)).rows[0].count;console.log(r.t+'.'+r.col,n)}
console.log((await c.query('select current_user, (select rolname from pg_roles r join pg_class k on k.relowner=r.oid where k.relname=$1) owner',['stock_movements'])).rows);
await c.end()})().catch(e=>console.error(e.message));

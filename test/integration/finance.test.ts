import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';
import { currentMonth, shiftMonth } from '../../src/modules/finance/common.js';

const PW = 'Sunrise#2025!';
let h: Harness;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function staffToken(email: string) {
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PW } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().accessToken as string;
}

let owner: string, samuel: string, zawadi: string, grace: string, ian: string, james: string, kevin: string;
let product: string, zone: string;
const thisMonth = currentMonth();
const lastMonth = shiftMonth(thisMonth, -1);
const twoAgo = shiftMonth(thisMonth, -2);

async function placeOrder(opts: { pay?: boolean; method?: 'mpesa' | 'card' } = {}) {
  const t = await h.token(uuidv7(), ['customer']);
  const res = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() },
    payload: { items: [{ productId: product, quantity: 1 }], paymentMethod: opts.method ?? 'mpesa', delivery: { name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } } });
  expect(res.statusCode).toBe(201);
  const o = res.json() as { id: string; totalCents: number; currency: string };
  const ref = `r-${uuidv7()}`;
  if (opts.pay !== false) {
    const p = await h.token(uuidv7(), ['payments']);
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${p}` }, payload: { paymentRef: ref, amountCents: o.totalCents, currency: o.currency } })).statusCode).toBe(200);
  }
  return { ...o, ref };
}
const fail = async (orderId: string, reason: string, ref: string) => {
  const p = await h.token(uuidv7(), ['payments']);
  return h.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payment-failure`, headers: { authorization: `Bearer ${p}` }, payload: { method: 'mpesa', reason, ref } });
};

async function newRider(phone: string, name: string) {
  expect((await call('POST', '/v1/rider/auth/code', null, { phone, purpose: 'signup' })).statusCode).toBe(204);
  expect((await call('POST', '/v1/rider/auth/verify', null, { phone, purpose: 'signup', code: '123456' })).statusCode).toBe(204);
  const reg = await call('POST', '/v1/rider/auth/register', null, { phone, password: 'Ride1234', name, vehicle: 'Motorbike', plate: 'KDA 284G', zoneId: zone });
  expect(reg.statusCode).toBe(201);
  const t = reg.json() as { accessToken: string; account: { id: string } };
  for (const key of ['id', 'license', 'insurance', 'photo', 'selfie']) await call('PUT', `/v1/admin/riders/${t.account.id}/documents/${key}`, james, { state: 'valid' });
  expect((await call('POST', `/v1/admin/riders/${t.account.id}/actions`, james, { action: 'approve' })).statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 0));
  h.c.riders.invalidate();
  return { id: t.account.id, token: t.accessToken };
}
/** A rider with `earned` cents who has asked to withdraw `amount`. */
async function pendingPayout(rider: { id: string; token: string }, earned: number, amount: number) {
  expect((await call('POST', `/v1/admin/riders/${rider.id}/adjustments`, samuel, { amountCents: earned, note: 'Test earnings' })).statusCode).toBe(204);
  const w = await call('POST', '/v1/rider/withdrawals', rider.token, { amountCents: amount });
  expect(w.statusCode).toBe(201);
  return w.json().id as string;
}

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456' });
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Samuel', 'samuel@t.co', 'Finance analyst');
  await add('Zawadi', 'zawadi@t.co', 'Finance analyst');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Ian', 'ian@t.co', 'IT support');
  await add('James', 'james@t.co', 'Operations manager');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  [owner, samuel, zawadi, grace, ian, james, kevin] = await Promise.all(['amara', 'samuel', 'zawadi', 'grace', 'ian', 'james', 'kevin'].map((n) => staffToken(`${n}@t.co`))) as string[] as [string, string, string, string, string, string, string];
  product = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 200 })).json().id;
  zone = (await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, commissionPct: 20, areas: ['Kilimani'] })).json().id;
});
afterAll(async () => { await h.close(); });

describe('who can see finance', () => {
  it('keeps money away from IT and support, and payroll away from anyone without payroll access', async () => {
    for (const t of [ian, grace]) {
      for (const url of ['/v1/admin/payments', '/v1/admin/finance/overview', '/v1/admin/expenses', '/v1/admin/invoices', '/v1/admin/accounts', '/v1/admin/payroll/profiles', '/v1/admin/payroll/runs']) {
        expect((await call('GET', url, t)).statusCode, url).toBe(403);
      }
    }
    expect((await call('GET', '/v1/admin/payments', samuel)).statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/payroll/profiles', james)).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/payments', null)).statusCode).toBe(401);
  });
});

describe('payments and failures', () => {
  it('lists money that came in with its order, method and reference', async () => {
    const o = await placeOrder();
    const list = (await call('GET', '/v1/admin/payments', samuel)).json();
    expect(list.items).toContainEqual(expect.objectContaining({ id: o.id, kind: 'payment', method: 'M-Pesa', amountCents: o.totalCents, ref: o.ref, status: 'Success' }));
    expect(list.totals.receivedCents).toBeGreaterThanOrEqual(o.totalCents);
    const d = (await call('GET', `/v1/admin/payments/${o.id}`, samuel)).json();
    expect(d).toMatchObject({ kind: 'payment', state: 'success', amountCents: o.totalCents, order: { id: o.id, status: 'PAID' } });
    expect(d.timeline.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining([expect.stringContaining('placed'), expect.stringContaining('Payment received')]));
    expect((await call('GET', `/v1/admin/payments/${uuidv7()}`, samuel)).statusCode).toBe(404);
  });

  it('records a failed attempt once, and a retry that clears pays the order', async () => {
    const o = await placeOrder({ pay: false });
    const f = await fail(o.id, 'Timeout at gateway', 'QGH-A1');
    expect(f.statusCode).toBe(200);
    expect(f.json().duplicate).toBe(false);
    expect((await fail(o.id, 'Timeout at gateway', 'qgh-a1')).json()).toMatchObject({ duplicate: true, id: f.json().id });
    const failures = (await call('GET', '/v1/admin/payments?failuresOnly=true', samuel)).json();
    expect(failures.items).toHaveLength(1);
    expect(failures.items[0]).toMatchObject({ id: f.json().id, state: 'failed', reason: 'Timeout at gateway', attempts: 1, status: 'Failed' });

    expect((await call('POST', `/v1/admin/payments/${f.json().id}/retry`, grace)).statusCode).toBe(403);
    const r = await call('POST', `/v1/admin/payments/${f.json().id}/retry`, samuel);
    expect(r.json()).toEqual({ outcome: 'recovered' });
    expect((await call('GET', `/v1/admin/orders/${o.id}`, samuel)).json()).toMatchObject({ paid: true });
    expect((await call('POST', `/v1/admin/payments/${f.json().id}/retry`, samuel)).json().error.code).toBe('NOT_RETRYABLE');
    const d = (await call('GET', `/v1/admin/payments/${f.json().id}`, samuel)).json();
    expect(d).toMatchObject({ kind: 'failure', state: 'recovered', attempts: 2 });
  });

  it('sends a payment that keeps failing to manual review instead of trying forever', async () => {
    const o = await placeOrder({ pay: false });
    const f = (await fail(o.id, 'Insufficient funds', 'QGH-B1')).json();
    expect((await call('POST', `/v1/admin/payments/${f.id}/retry`, samuel)).json()).toMatchObject({ outcome: 'failed' });
    expect((await call('POST', `/v1/admin/payments/${f.id}/retry`, samuel)).json()).toMatchObject({ outcome: 'manual_review' });
    expect((await call('POST', `/v1/admin/payments/${f.id}/retry`, samuel)).json().error.code).toBe('NOT_RETRYABLE');
    expect((await call('GET', `/v1/admin/orders/${o.id}`, samuel)).json()).toMatchObject({ paid: false });
  });

  it('retries only the failures that usually clear', async () => {
    const a = await placeOrder({ pay: false });
    const b = await placeOrder({ pay: false });
    await fail(a.id, 'Network error', 'QGH-C1');
    await fail(b.id, 'Authentication failed', 'QGH-C2');
    expect((await call('POST', '/v1/admin/payments/retry-eligible', samuel)).json()).toEqual({ tried: 1, recovered: 1, stillFailing: 0 });
    expect((await call('GET', `/v1/admin/orders/${a.id}`, samuel)).json()).toMatchObject({ paid: true });
    expect((await call('GET', `/v1/admin/orders/${b.id}`, samuel)).json()).toMatchObject({ paid: false });
  });

  it('only the payment service can report a failure', async () => {
    const o = await placeOrder({ pay: false });
    const t = await h.token(uuidv7(), ['customer']);
    const res = await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-failure`, headers: { authorization: `Bearer ${t}` }, payload: { method: 'mpesa', reason: 'x', ref: 'QGH-D1' } });
    expect(res.statusCode).toBe(403);
    expect((await fail(uuidv7(), 'x', 'QGH-D2')).statusCode).toBe(404);
  });
});

describe('reconciliation', () => {
  it('matches a gateway statement to orders, flags differences and lets a person resolve them', async () => {
    const good = await placeOrder();
    const off = await placeOrder();
    const csv = ['Receipt reference,Amount (KES)', `${good.ref},${(good.totalCents / 100).toFixed(2)}`, `${off.ref},"${((off.totalCents + 27_000) / 100).toLocaleString('en-US')}"`, 'QGH8K2P67R,1250'].join('\n');
    const imp = await call('POST', '/v1/admin/reconciliation', samuel, { file: 'MPESA-YESTERDAY.csv', text: csv });
    expect(imp.statusCode).toBe(201);
    const s = imp.json();
    expect(s.summary).toEqual({ total: 3, matched: 1, mismatched: 1, unmatched: 1, resolved: 0 });
    const lines = Object.fromEntries(s.lines.map((l: { ref: string }) => [l.ref, l]));
    expect(lines[off.ref]).toMatchObject({ state: 'Mismatch', gatewayCents: off.totalCents + 27_000, oursCents: off.totalCents });

    const sid = s.id as string;
    expect((await call('POST', `/v1/admin/reconciliation/${sid}/lines/${lines[off.ref].id}/resolve`, samuel, { how: 'adjusted', note: 'x' })).statusCode).toBe(400);
    const r1 = await call('POST', `/v1/admin/reconciliation/${sid}/lines/${lines[off.ref].id}/resolve`, samuel, { how: 'adjusted', note: 'Gateway fee included' });
    expect(r1.json().summary.resolved).toBe(1);
    expect((await call('POST', `/v1/admin/reconciliation/${sid}/lines/${lines.QGH8K2P67R.id}/resolve`, samuel, { how: 'matched_manually', note: 'Belongs to an order' })).json().error.code).toBe('ORDER_REQUIRED');
    const r2 = await call('POST', `/v1/admin/reconciliation/${sid}/lines/${lines.QGH8K2P67R.id}/resolve`, samuel, { how: 'written_off', note: 'Not ours: duplicate from the paybill' });
    expect(r2.json().summary).toMatchObject({ resolved: 2, unmatched: 0, mismatched: 0 });
    expect((await call('GET', '/v1/admin/reconciliation', samuel)).json().id).toBe(sid);

    expect((await call('POST', `/v1/admin/reconciliation/${sid}/complete`, grace)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/reconciliation/${sid}/complete`, samuel)).json()).toMatchObject({ completed: true });
    expect((await call('POST', `/v1/admin/reconciliation/${sid}/lines/${lines[good.ref].id}/resolve`, samuel, { how: 'adjusted', note: 'too late' })).json().error.code).toBe('STATEMENT_COMPLETED');
  });

  it('rejects files it can’t read', async () => {
    const bad = async (text: string) => (await call('POST', '/v1/admin/reconciliation', samuel, { file: 'x.csv', text })).statusCode;
    expect(await bad('Receipt reference,Amount\n')).toBe(400);
    expect(await bad('Date,Total\n1,2')).toBe(400);
    expect(await bad('Reference,Amount\nA1,abc')).toBe(400);
    expect(await bad('Reference,Amount\nA1,10\na1,10')).toBe(400);
  });
});

describe('rider payouts in batches', () => {
  let r1: { id: string; token: string }, r2: { id: string; token: string };
  let p1: string, p2: string;
  beforeAll(async () => {
    r1 = await newRider('+254733000001', 'Rider One');
    r2 = await newRider('+254733000010', 'Rider Ten');
    p1 = await pendingPayout(r1, 60_000, 20_000);
    p2 = await pendingPayout(r2, 60_000, 20_000);
  });

  it('needs a second pair of eyes to send, and one failed number doesn’t stop the rest', async () => {
    const created = await call('POST', '/v1/admin/payout-batches', samuel, { payoutIds: [p1, p2], note: 'Friday run' });
    expect(created.statusCode).toBe(201);
    const b = created.json();
    expect(b).toMatchObject({ status: 'draft', createdBy: 'Samuel', totalCents: 40_000 });
    expect((await call('POST', '/v1/admin/payout-batches', zawadi, { payoutIds: [p1] })).json().error.code).toBe('PAYOUTS_UNAVAILABLE');
    expect((await call('POST', `/v1/admin/payout-batches/${b.id}/send`, samuel)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/payout-batches/${b.id}/send`, grace)).statusCode).toBe(403);

    const sent = (await call('POST', `/v1/admin/payout-batches/${b.id}/send`, zawadi)).json();
    expect(sent).toMatchObject({ status: 'sent', approvedBy: 'Zawadi' });
    const byRider = Object.fromEntries(sent.items.map((i: { rider: string }) => [i.rider, i]));
    expect(byRider['Rider One']).toMatchObject({ status: 'paid', outcome: 'paid' });
    expect(byRider['Rider Ten']).toMatchObject({ status: 'failed', outcome: 'failed', failureReason: expect.stringContaining('M-Pesa') });
    // The failed payout’s money goes back to the rider.
    expect((await call('GET', '/v1/rider/earnings', r2.token)).json().balanceCents).toBe(60_000);
    expect((await call('GET', '/v1/rider/earnings', r1.token)).json().balanceCents).toBe(60_000 - 20_000 - 1_500);
    // Sending again changes nothing.
    expect((await call('POST', `/v1/admin/payout-batches/${b.id}/send`, zawadi)).json().status).toBe('sent');
    expect((await call('GET', '/v1/admin/payouts?status=paid', samuel)).json().items).toHaveLength(1);
    expect((await call('PATCH', `/v1/admin/payout-batches/${b.id}`, samuel, { note: 'late' })).json().error.code).toBe('BATCH_SENT');
    expect((await call('GET', '/v1/admin/payout-batches', samuel)).json().items[0]).toMatchObject({ number: expect.stringMatching(/^PB-/), payouts: 2, failed: 1 });
  });

  it('lets an owner approve a batch they prepared, and drafts can be edited or deleted', async () => {
    const p3 = await pendingPayout(r1, 30_000, 20_000);
    const p4 = await pendingPayout(r1, 30_000, 20_000);
    const b = (await call('POST', '/v1/admin/payout-batches', owner, { payoutIds: [p3, p4] })).json();
    const edited = (await call('PATCH', `/v1/admin/payout-batches/${b.id}`, owner, { payoutIds: [p3], note: 'Just one' })).json();
    expect(edited).toMatchObject({ note: 'Just one', totalCents: 20_000 });
    expect(edited.items).toHaveLength(1);
    // The payout dropped from the batch is free to go in another.
    const b2 = (await call('POST', '/v1/admin/payout-batches', samuel, { payoutIds: [p4] })).json();
    expect((await call('DELETE', `/v1/admin/payout-batches/${b2.id}`, samuel)).statusCode).toBe(204);
    expect((await call('GET', `/v1/admin/payout-batches/${b2.id}`, samuel)).statusCode).toBe(404);
    expect((await call('POST', `/v1/admin/payout-batches/${b.id}/send`, owner)).json()).toMatchObject({ status: 'sent', approvedBy: 'Amara', createdBy: 'Amara' });
  });
});

describe('expenses', () => {
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  it('is approved by someone other than the person who entered it', async () => {
    const e = await call('POST', '/v1/admin/expenses', samuel, { date: today, category: 'Software', payee: 'CloudRoute Ltd', description: 'Monthly subscription', amountCents: 54_000_00 });
    expect(e.statusCode).toBe(201);
    expect(e.json()).toMatchObject({ status: 'pending', by: 'Samuel', number: expect.stringMatching(/^EX-/) });
    expect((await call('POST', `/v1/admin/expenses/${e.json().id}/decision`, samuel, { to: 'approved' })).json().error.message).toContain('entered yourself');
    expect((await call('POST', `/v1/admin/expenses/${e.json().id}/decision`, grace, { to: 'approved' })).statusCode).toBe(403);
    const ok = await call('POST', `/v1/admin/expenses/${e.json().id}/decision`, zawadi, { to: 'approved', note: 'Invoice checked' });
    expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: 'Zawadi', note: 'Invoice checked' });
    expect((await call('POST', `/v1/admin/expenses/${e.json().id}/decision`, zawadi, { to: 'rejected' })).json().error.code).toBe('ALREADY_DECIDED');
  });

  it('sends big expenses to an owner and approves an owner’s own entries on the spot', async () => {
    const big = await call('POST', '/v1/admin/expenses', samuel, { date: today, category: 'Marketing', payee: 'Meta Platforms', amountCents: 248_000_00 });
    expect((await call('POST', `/v1/admin/expenses/${big.json().id}/decision`, zawadi, { to: 'approved' })).json().error.message).toContain('owner');
    expect((await call('POST', `/v1/admin/expenses/${big.json().id}/decision`, owner, { to: 'approved' })).json().status).toBe('approved');
    const own = await call('POST', '/v1/admin/expenses', owner, { date: today, category: 'Office & hub', payee: 'Nairobi Workspaces', amountCents: 186_000_00 });
    expect(own.json()).toMatchObject({ status: 'approved', decidedBy: 'Amara' });
    const rej = await call('POST', '/v1/admin/expenses', samuel, { date: today, category: 'Marketing', payee: 'Radio Africa', amountCents: 12_000_00 });
    expect((await call('POST', `/v1/admin/expenses/${rej.json().id}/decision`, zawadi, { to: 'rejected', note: 'No quote' })).json()).toMatchObject({ status: 'rejected' });
    const list = (await call('GET', '/v1/admin/expenses?status=approved', samuel)).json();
    expect(list.items).toHaveLength(3);
    expect(list.approvedThisMonthCents).toBe(54_000_00 + 248_000_00 + 186_000_00);
    expect((await call('POST', '/v1/admin/expenses', samuel, { date: today, category: 'Other', payee: 'x', amountCents: 0 })).statusCode).toBe(400);
    expect((await call('POST', '/v1/admin/expenses', samuel, { date: '2026-02-31', category: 'Other', payee: 'x', amountCents: 100 })).statusCode).toBe(400);
  });
});

describe('invoices', () => {
  it('moves from draft to sent to paid, and works out VAT and balances', async () => {
    const created = await call('POST', '/v1/admin/invoices', samuel, {
      customer: 'Kifaru Roasters Ltd', contact: 'Joseph Kariuki', email: 'accounts@kifaru.co.ke', dueInDays: 30, draft: true,
      lines: [{ description: 'Marketplace orders', quantity: 118, unitCents: 1_300_00 }, { description: 'Delivery fees', quantity: 118, unitCents: 180_00 }],
    });
    expect(created.statusCode).toBe(201);
    const inv = created.json();
    const subtotal = 118 * 1_300_00 + 118 * 180_00;
    expect(inv).toMatchObject({ status: 'Draft', subtotalCents: subtotal, vatCents: Math.round(subtotal * 0.16), vatRate: 16, balanceCents: Math.round(subtotal * 1.16) });
    expect((await call('POST', `/v1/admin/invoices/${inv.id}/remind`, samuel)).json().error.code).toBe('NOT_SENT');
    const sent = (await call('POST', `/v1/admin/invoices/${inv.id}/send`, samuel)).json();
    expect(sent).toMatchObject({ status: 'Sent', draft: false });
    expect((await call('POST', `/v1/admin/invoices/${inv.id}/send`, samuel)).json().error.code).toBe('NOT_A_DRAFT');
    expect((await call('DELETE', `/v1/admin/invoices/${inv.id}`, samuel)).json().error.code).toBe('NOT_A_DRAFT');

    expect((await call('POST', `/v1/admin/invoices/${inv.id}/payments`, samuel, { amountCents: sent.totalCents + 1, method: 'Bank transfer', ref: 'BK-1' })).json().error.code).toBe('MORE_THAN_OWED');
    const part = (await call('POST', `/v1/admin/invoices/${inv.id}/payments`, samuel, { amountCents: 10_000_00, method: 'Bank transfer', ref: 'BK-1' })).json();
    expect(part).toMatchObject({ status: 'Partly paid', paidCents: 10_000_00, balanceCents: sent.totalCents - 10_000_00 });
    expect((await call('POST', `/v1/admin/invoices/${inv.id}/payments`, samuel, { amountCents: 100, method: 'Bank transfer', ref: 'bk-1' })).json().error.code).toBe('REF_USED');
    expect((await call('POST', `/v1/admin/invoices/${inv.id}/remind`, samuel)).json().reminders).toHaveLength(1);
    const paid = (await call('POST', `/v1/admin/invoices/${inv.id}/payments`, samuel, { amountCents: part.balanceCents, method: 'Bank transfer', ref: 'BK-2' })).json();
    expect(paid).toMatchObject({ status: 'Paid', balanceCents: 0 });
    expect((await call('POST', `/v1/admin/invoices/${inv.id}/remind`, samuel)).json().error.code).toBe('ALREADY_PAID');
    expect((await call('GET', '/v1/admin/invoices?status=Paid', samuel)).json().items).toHaveLength(1);
  });

  it('flags an invoice that is past its date, and a draft can be thrown away', async () => {
    const o = (await call('POST', '/v1/admin/invoices', samuel, { customer: 'Amani Grocers', dueInDays: 0, lines: [{ description: 'Bulk delivery', quantity: 1, unitCents: 36_640_00 }] })).json();
    await new Promise((r) => setTimeout(r, 15));
    expect((await call('GET', `/v1/admin/invoices/${o.id}`, samuel)).json().status).toBe('Overdue');
    const list = (await call('GET', '/v1/admin/invoices', samuel)).json();
    expect(list.overdueCount).toBe(1);
    expect(list.overdueCents).toBe(Math.round(36_640_00 * 1.16));
    const d = (await call('POST', '/v1/admin/invoices', samuel, { customer: 'Draft Co', draft: true, lines: [{ description: 'x', quantity: 1, unitCents: 100 }] })).json();
    expect((await call('DELETE', `/v1/admin/invoices/${d.id}`, samuel)).statusCode).toBe(204);
    expect((await call('POST', '/v1/admin/invoices', samuel, { customer: 'No lines', lines: [] })).statusCode).toBe(400);
  });
});

describe('VAT and closing a month', () => {
  it('prepares and files a return once, only after the month is over', async () => {
    expect((await call('POST', `/v1/admin/vat/${thisMonth}/prepare`, samuel)).json().error.code).toBe('MONTH_NOT_OVER');
    expect((await call('POST', `/v1/admin/vat/${lastMonth}/file`, samuel, { ack: 'KRA-VAT-123456' })).json().error.code).toBe('NOT_PREPARED');
    const p = (await call('POST', `/v1/admin/vat/${lastMonth}/prepare`, samuel)).json();
    expect(p.items.find((i: { month: string }) => i.month === lastMonth).filing).toMatchObject({ status: 'draft', preparedBy: 'Samuel' });
    expect((await call('POST', `/v1/admin/vat/${lastMonth}/file`, samuel, { ack: 'bad' })).statusCode).toBe(400);
    const f = (await call('POST', `/v1/admin/vat/${lastMonth}/file`, samuel, { ack: 'KRA-VAT-884201' })).json();
    expect(f.items.find((i: { month: string }) => i.month === lastMonth).filing).toMatchObject({ status: 'filed', ack: 'KRA-VAT-884201' });
    expect((await call('POST', `/v1/admin/vat/${lastMonth}/prepare`, samuel)).json().error.code).toBe('ALREADY_FILED');
    const now = f.items.find((i: { month: string }) => i.month === thisMonth);
    expect(now.collectedCents).toBeGreaterThan(0);
    const gross = now.taxableCents + now.collectedCents;
    expect(now.collectedCents).toBe(Math.round(gross - gross / 1.16));
  });

  it('won’t close a month with open controls, and a closed month takes no new entries until an owner reopens it', async () => {
    expect((await call('POST', `/v1/admin/periods/${thisMonth}/close`, samuel, {})).json().error.code).toBe('MONTH_NOT_OVER');
    const st = (await call('GET', `/v1/admin/periods/${twoAgo}`, samuel)).json();
    expect(st.ready).toBe(false);
    expect(st.checks.map((c: { key: string }) => c.key)).toEqual(['reconcile', 'cod', 'payouts', 'expenses', 'vat', 'payroll']);
    expect((await call('POST', `/v1/admin/periods/${twoAgo}/close`, samuel, {})).json().error.code).toBe('CONTROLS_OPEN');

    // Lock the month directly: a full close needs a paid payroll run and a filed return, covered above.
    await h.db.query(`INSERT INTO period_closes (month, closed_by, note) VALUES ($1, 'Amara', 'Closed after VAT filing')`, [twoAgo]);
    const day = `${twoAgo}-15`;
    expect((await call('POST', '/v1/admin/expenses', samuel, { date: day, category: 'Other', payee: 'Late bill', amountCents: 5_000_00 })).json().error.code).toBe('PERIOD_CLOSED');
    expect((await call('GET', '/v1/admin/periods', samuel)).json().items).toEqual([expect.objectContaining({ month: twoAgo, closedBy: 'Amara' })]);
    expect((await call('GET', `/v1/admin/periods/${twoAgo}`, samuel)).json().closed).toMatchObject({ by: 'Amara' });
    expect((await call('DELETE', `/v1/admin/periods/${twoAgo}`, samuel)).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/admin/periods/${twoAgo}`, owner)).json().closed).toBeNull();
    expect((await call('POST', '/v1/admin/expenses', samuel, { date: day, category: 'Other', payee: 'Late bill', amountCents: 5_000_00 })).statusCode).toBe(201);
  });
});

describe('payroll', () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    const items = (await call('GET', '/v1/admin/payroll/profiles', samuel)).json().items as { staffId: string; name: string }[];
    ids = Object.fromEntries(items.map((i) => [i.name, i.staffId]));
  });

  it('keeps pay profiles to those with payroll access and only changes the fields sent', async () => {
    expect((await call('PATCH', `/v1/admin/payroll/profiles/${ids.Grace}`, james, { basicCents: 1 })).statusCode).toBe(403);
    const first = await call('PATCH', `/v1/admin/payroll/profiles/${ids.Grace}`, samuel, { basicCents: 62_000_00, houseCents: 8_000_00, transportCents: 5_000_00, kraPin: 'a123456789b', payTo: 'M-Pesa 0712 ••• 441' });
    expect(first.json()).toMatchObject({ basicCents: 62_000_00, kraPin: 'A123456789B', hasProfile: true });
    const second = await call('PATCH', `/v1/admin/payroll/profiles/${ids.Grace}`, samuel, { transportCents: 6_000_00 });
    expect(second.json()).toMatchObject({ basicCents: 62_000_00, houseCents: 8_000_00, transportCents: 6_000_00, kraPin: 'A123456789B' });
    await call('PATCH', `/v1/admin/payroll/profiles/${ids.Ian}`, samuel, { basicCents: 95_000_00, houseCents: 10_000_00, transportCents: 6_000_00 });
    await call('PATCH', `/v1/admin/payroll/profiles/${ids.James}`, samuel, { basicCents: 110_000_00 });
    expect((await call('PATCH', `/v1/admin/payroll/profiles/${uuidv7()}`, samuel, { basicCents: 1 })).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/admin/payroll/profiles/${ids.Grace}`, samuel, {})).statusCode).toBe(400);
    // Pay amounts never reach the audit log, only what kind of change was made.
    const audit = await h.db.query(`SELECT data FROM audit_log WHERE action = 'payroll.profile' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(audit.rows[0].data)).not.toContain('62');
  });

  it('keeps rates as settings and checks them', async () => {
    const st = (await call('GET', '/v1/admin/payroll/statutory', samuel)).json();
    expect(st).toMatchObject({ nssfRate: 6, shifRate: 2.75, housingRate: 1.5 });
    expect((await call('PUT', '/v1/admin/payroll/statutory', samuel, { ...st, bands: [[1000, 10]] })).statusCode).toBe(400);
    expect((await call('PUT', '/v1/admin/payroll/statutory', grace, st)).statusCode).toBe(403);
    expect((await call('PUT', '/v1/admin/payroll/statutory', samuel, st)).statusCode).toBe(200);
  });

  it('is prepared by one person, approved by the owner and never by whoever prepared it', async () => {
    expect((await call('POST', '/v1/admin/payroll/runs', samuel, { month: shiftMonth(thisMonth, 1) })).json().error.code).toBe('FUTURE_MONTH');
    const created = await call('POST', '/v1/admin/payroll/runs', samuel, { month: lastMonth });
    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run).toMatchObject({ status: 'Draft', preparedBy: 'Samuel' });
    expect(run.lines.map((l: { name: string }) => l.name).sort()).toEqual(['Grace', 'Ian', 'James']);
    expect((await call('POST', '/v1/admin/payroll/runs', samuel, { month: lastMonth })).json().error.code).toBe('RUN_EXISTS');

    const grace0 = run.lines.find((l: { name: string }) => l.name === 'Grace').slip;
    expect(grace0.grossCents).toBe(62_000_00 + 8_000_00 + 6_000_00);
    expect(grace0.netCents).toBe(grace0.grossCents - grace0.nssfCents - grace0.shifCents - grace0.housingCents - grace0.payeCents);
    const adj = (await call('POST', `/v1/admin/payroll/runs/${run.id}/adjust/${ids.Grace}`, samuel, { bonusCents: 10_000_00, otherDeductionCents: 2_000_00, note: 'Advance' })).json();
    const grace1 = adj.lines.find((l: { name: string }) => l.name === 'Grace');
    expect(grace1.slip.grossCents).toBe(grace0.grossCents + 10_000_00);
    expect(grace1.slip.otherDeductionCents).toBe(2_000_00);
    expect(grace1.slip.payeCents).toBeGreaterThan(grace0.payeCents);
    expect((await call('POST', `/v1/admin/payroll/runs/${run.id}/adjust/${ids.Grace}`, samuel, { bonusCents: 0, otherDeductionCents: 99_000_000_00 })).statusCode).toBe(422);

    const act = (action: string, token: string) => call('POST', `/v1/admin/payroll/runs/${run.id}/action`, token, { action });
    expect((await act('approve', samuel)).json().error.code).toBe('WRONG_STATE');
    expect((await act('pay', samuel)).json().error.code).toBe('WRONG_STATE');
    expect((await act('submit', samuel)).json().status).toBe('Pending approval');
    expect((await call('POST', `/v1/admin/payroll/runs/${run.id}/adjust/${ids.Grace}`, samuel, { bonusCents: 0, otherDeductionCents: 0 })).json().error.code).toBe('RUN_LOCKED');
    expect((await act('approve', samuel)).json().error.message).toContain('owner');
    expect((await act('approve', zawadi)).statusCode).toBe(403);
    expect((await act('return', zawadi)).json().status).toBe('Draft');
    expect((await act('submit', zawadi)).statusCode).toBe(200);
    expect((await act('approve', owner)).json()).toMatchObject({ status: 'Approved', approvedBy: 'Amara' });

    // Deductions can be marked paid to the authorities once approved, each only once.
    const run2 = (await call('GET', `/v1/admin/payroll/runs/${run.id}`, samuel)).json();
    expect(run2.remittances.map((r: { kind: string }) => r.kind)).toEqual(['PAYE', 'NSSF', 'SHIF', 'Housing levy']);
    expect(run2.remittances[0]).toMatchObject({ to: 'KRA', amountCents: run2.totals.payeCents, paid: null });
    expect(run2.totals.nssfCents).toBe(run2.lines.reduce((n: number, l: { slip: { nssfCents: number } }) => n + l.slip.nssfCents * 2, 0));
    expect((await call('POST', `/v1/admin/payroll/runs/${run.id}/remittances`, samuel, { kind: 'PAYE', ref: 'KRA-PAYE-1' })).json().remittances[0].paid).toMatchObject({ ref: 'KRA-PAYE-1' });
    expect((await call('POST', `/v1/admin/payroll/runs/${run.id}/remittances`, samuel, { kind: 'PAYE', ref: 'KRA-PAYE-2' })).json().error.code).toBe('ALREADY_REMITTED');
    expect((await act('pay', samuel)).json()).toMatchObject({ status: 'Paid', paidBy: 'Samuel' });
    const slip = (await call('GET', `/v1/admin/payroll/runs/${run.id}/payslips/${ids.Grace}`, samuel)).json();
    expect(slip).toMatchObject({ name: 'Grace', month: lastMonth, status: 'Paid', note: 'Advance' });
    expect((await call('GET', `/v1/admin/payroll/runs/${run.id}/payslips/${ids.Grace}`, grace)).statusCode).toBe(403);
  });

  it('gives the owner no exception: a run they prepared needs someone else’s sign-off, which only an owner can give', async () => {
    const run = (await call('POST', '/v1/admin/payroll/runs', owner, { month: thisMonth })).json();
    await call('POST', `/v1/admin/payroll/runs/${run.id}/action`, owner, { action: 'submit' });
    const res = await call('POST', `/v1/admin/payroll/runs/${run.id}/action`, owner, { action: 'approve' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('prepared');
  });
});

describe('reports, accounts and exports', () => {
  it('summarises the month and the money held and owed', async () => {
    const o = (await call('GET', '/v1/admin/finance/overview', samuel)).json();
    expect(o.month).toBe(thisMonth);
    expect(o.summary.orders).toBeGreaterThanOrEqual(5);
    expect(o.summary.grossCents).toBeGreaterThan(4 * 485_000);
    expect(o.daily).toHaveLength(30);
    expect(o.recentPayments.length).toBeGreaterThan(0);
    expect(o.attention.map((a: { key: string }) => a.key)).toEqual(expect.arrayContaining(['manual-review', 'expenses', 'payroll']));
    const a = (await call('GET', '/v1/admin/accounts', samuel)).json();
    expect(a.holds.map((h: { key: string }) => h.key)).toEqual(['payments', 'cod', 'invoices']);
    expect(a.holds[0].cents).toBeGreaterThan(0);
    expect(a.netCents).toBe(a.holdsTotalCents - a.owesTotalCents);
    expect(a.journal.length).toBeGreaterThan(0);
    expect(a.owes.find((x: { key: string }) => x.key === 'riders').cents).toBeGreaterThan(0);
  });

  it('works out profit and loss with VAT taken out and approved expenses and payroll counted', async () => {
    const p = (await call('GET', `/v1/admin/reports/profit-and-loss?month=${thisMonth}`, samuel)).json();
    expect(p.month).toBe(thisMonth);
    expect(p.revenueCents).toBe(p.productNetCents + p.deliveryNetCents - p.refundsNetCents);
    expect(p.grossProfitCents).toBe(p.revenueCents - p.cogsCents);
    expect(p.expensesCents).toBe(54_000_00 + 248_000_00 + 186_000_00);
    expect(p.netCents).toBe(p.grossProfitCents - p.opexCents);
    expect(p.expenseByCategory[0]).toEqual(['Marketing', 248_000_00]);
    expect(p.trend).toHaveLength(6);
    const last = (await call('GET', `/v1/admin/reports/profit-and-loss?month=${lastMonth}`, samuel)).json();
    expect(last.payrollCents).toBeGreaterThan(0); // the approved, paid run counts as employer cost
  });

  it('breaks sales down and compares delivery fees to rider pay', async () => {
    const s = (await call('GET', '/v1/admin/reports/sales', samuel)).json();
    expect(s.orders).toBeGreaterThanOrEqual(5);
    expect(s.topProducts[0]).toMatchObject({ name: 'Leather Tote' });
    expect(s.byArea[0].area).toBe('Kilimani');
    expect((await call('GET', '/v1/admin/reports/sales?from=2026-05-02&to=2026-05-01', samuel)).statusCode).toBe(400);
    expect((await call('GET', `/v1/admin/reports/delivery-cost?month=${thisMonth}`, samuel)).json()).toMatchObject({ month: thisMonth, items: [] });
    expect((await call('GET', '/v1/admin/reports/sales', grace)).statusCode).toBe(403);
  });

  it('keeps settings that change the figures, owner or finance only', async () => {
    expect((await call('PATCH', '/v1/admin/finance/settings', grace, { cogsRate: 50 })).statusCode).toBe(403);
    expect((await call('PATCH', '/v1/admin/finance/settings', samuel, { cogsRate: 150 })).statusCode).toBe(400);
    const s = (await call('PATCH', '/v1/admin/finance/settings', samuel, { cogsRate: 50 })).json();
    expect(s).toMatchObject({ cogsRate: 50, storeCommission: 12, vatRate: 16, codWindowHours: 24 });
    const p = (await call('GET', `/v1/admin/reports/profit-and-loss?month=${thisMonth}`, samuel)).json();
    expect(p.cogsCents).toBe(Math.round(p.productNetCents / 2));
  });

  it('exports CSV that a spreadsheet can’t be tricked by, and logs who took it', async () => {
    const res = await call('POST', '/v1/admin/exports', samuel, { dataset: 'Payments', format: 'CSV' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('payments.csv');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('Payment,Order,Method,Amount (KES),Reference,Paid at');
    expect(lines[1]).toMatch(/^PAY-\d+,SC-\d+,mpesa,\d+(\.\d+)?,/);
    expect((await call('POST', '/v1/admin/exports', samuel, { dataset: 'Payments', format: 'Excel' })).json().error.code).toBe('FORMAT_UNAVAILABLE');
    for (const dataset of ['Refunds', 'Rider payouts', 'COD balances', 'Expenses', 'Invoices', 'VAT summary', 'Profit and loss', 'Payroll summary', 'Store settlements']) {
      expect((await call('POST', '/v1/admin/exports', samuel, { dataset, format: 'CSV' })).statusCode, dataset).toBe(200);
    }
    expect((await call('POST', '/v1/admin/exports', grace, { dataset: 'Payments', format: 'CSV' })).statusCode).toBe(403);
    const log = (await call('GET', '/v1/admin/exports', samuel)).json();
    expect(log.items[0]).toMatchObject({ by: 'Samuel' });
    expect(log.items.length).toBe(10);
    // A cell that starts like a formula is neutralised.
    const { csvCell } = await import('../../src/modules/finance/common.js');
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('-250')).toBe('-250');
  });

  it('lists store settlements once orders are delivered, and keeps them out of reach of anyone without access', async () => {
    expect((await call('GET', '/v1/admin/settlements', samuel)).json()).toMatchObject({ items: [], payableCents: 0 });
    expect((await call('POST', '/v1/admin/settlements/ST-202601-MAIN/pay', samuel, { ref: 'EFT-1' })).statusCode).toBe(404);
    expect((await call('GET', '/v1/admin/settlements', ian)).statusCode).toBe(403);
  });
});

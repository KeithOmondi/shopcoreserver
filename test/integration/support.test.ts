import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';
import { uuidv7 } from '../../src/infra/uuid.js';

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

let owner: string, grace: string, samuel: string, ruth: string, kevin: string, james: string;
let product: string;
const wanjiku = uuidv7();
let customer: string; // Wanjiku's token

/** A customer order, paid, and optionally delivered. */
async function order(opts: { qty?: number; delivered?: boolean; user?: string; pay?: boolean } = {}) {
  const userId = opts.user ?? wanjiku;
  const t = await h.token(userId, ['customer']);
  const res = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t}`, 'idempotency-key': idemKey() },
    payload: { items: [{ productId: product, quantity: opts.qty ?? 1 }], paymentMethod: 'mpesa', delivery: { name: 'Wanjiku Njoroge', phone: '+254 712 555 001', area: 'Kilimani', address: 'Argwings Kodhek Rd' } } });
  expect(res.statusCode).toBe(201);
  const o = res.json() as { id: string; totalCents: number; currency: string };
  if (opts.pay !== false) {
    const p = await h.token(uuidv7(), ['payments']);
    expect((await h.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payment-confirmation`, headers: { authorization: `Bearer ${p}` }, payload: { paymentRef: `r-${uuidv7()}`, amountCents: o.totalCents, currency: o.currency } })).statusCode).toBe(200);
  }
  if (opts.delivered) expect((await call('POST', `/v1/orders/${o.id}/fulfillment`, owner, {})).statusCode).toBe(200);
  return o;
}

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ RIDER_DEV_OTP: '123456' });
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (n: string, e: string, r: string) => s.insertRaw({ name: n, email: e, role: r, status: 'active', password: PW, mustChange: false });
  await add('Amara', 'amara@t.co', 'Owner admin');
  await add('Grace', 'grace@t.co', 'Customer support');
  await add('Samuel', 'samuel@t.co', 'Finance analyst');
  await add('Ruth', 'ruth@t.co', 'Marketing manager');
  await add('Kevin', 'kevin@t.co', 'Inventory manager');
  await add('James', 'james@t.co', 'Operations manager');
  [owner, grace, samuel, ruth, kevin, james] = await Promise.all(['amara', 'grace', 'samuel', 'ruth', 'kevin', 'james'].map((n) => staffToken(`${n}@t.co`)) as Promise<string>[]) as string[] as [string, string, string, string, string, string];
  product = (await call('POST', '/v1/admin/products', kevin, { sku: 'TOTE-1', name: 'Leather Tote', priceCents: 485_000, currency: 'KES', initialStock: 100 })).json().id;
  customer = await h.token(wanjiku, ['customer']);
  await order(); // creates Wanjiku's profile
});
afterAll(async () => { await h.close(); });

describe('help centre', () => {
  it('keeps drafts private, publishes, counts reads and remembers what people could not find', async () => {
    const a = await call('POST', '/v1/admin/articles', grace, { title: 'Where is my order?', category: 'Delivery and tracking', body: 'Open Orders, then tap Track.' });
    expect(a.statusCode).toBe(201);
    expect((await call('GET', '/v1/help/articles?q=track', null)).json().items).toHaveLength(0);
    expect((await call('GET', `/v1/help/articles/${a.json().id}`, null)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/admin/articles/${a.json().id}`, grace, { live: true })).statusCode).toBe(200);
    const found = (await call('GET', '/v1/help/articles?q=track', null)).json().items as { title: string; excerpt: string }[];
    expect(found).toEqual([expect.objectContaining({ title: 'Where is my order?', excerpt: 'Open Orders, then tap Track.' })]);
    await call('GET', `/v1/help/articles/${a.json().id}`, null);
    await call('GET', '/v1/help/articles?q=gift%20wrapping', null);
    await call('GET', '/v1/help/articles?q=gift%20wrapping', null);
    expect((await call('GET', '/v1/admin/articles', grace)).json().items[0].views).toBe(1);
    expect((await call('GET', '/v1/admin/help/missed-searches', grace)).json().items).toEqual([{ q: 'gift wrapping', count: 2 }, { q: 'track', count: 1 }]); // the draft was not searchable yet
    expect((await call('POST', '/v1/admin/articles', ruth, { title: 'x', category: 'y' })).statusCode).toBe(403);
  });

  it('keeps canned replies for the team', async () => {
    const c = await call('POST', '/v1/admin/canned-replies', grace, { title: 'Delay apology', category: 'Delivery', text: 'Hi {{customer_name}}, sorry about the wait.' });
    expect(c.statusCode).toBe(201);
    await call('POST', `/v1/admin/canned-replies/${c.json().id}/use`, grace);
    expect((await call('GET', '/v1/admin/canned-replies', grace)).json().items[0]).toMatchObject({ uses: 1, live: true });
  });
});

describe('tickets', () => {
  let ticket: string;
  it('lets a shopper open a ticket about their order and keeps staff notes off their screen', async () => {
    const o = await order();
    const r = await call('POST', '/v1/support/tickets', customer, { subject: 'Wrong colour delivered', category: 'Order issue', orderId: o.id, message: 'I ordered black but got tan.' });
    expect(r.statusCode).toBe(201);
    ticket = r.json().id;
    expect((await call('POST', '/v1/support/tickets', customer, { subject: 'x', orderId: uuidv7(), message: 'hi' })).statusCode).toBe(404);
    const staff = (await call('GET', `/v1/admin/tickets/${ticket}`, grace)).json();
    expect(staff).toMatchObject({ kind: 'customer', status: 'open', priority: 'normal', person: 'Wanjiku Njoroge', breached: false });
    expect(staff.number).toMatch(/^T-\d+$/);
    expect(staff.order).toMatch(/^SC-/);

    await call('POST', `/v1/admin/tickets/${ticket}/reply`, grace, { text: 'Checking with the warehouse.', internal: true });
    const rep = await call('POST', `/v1/admin/tickets/${ticket}/reply`, grace, { text: 'So sorry! We are sending the right one.' });
    expect(rep.json()).toMatchObject({ status: 'pending', assignee: 'Grace' });
    expect(rep.json().firstResponseAt).toBeTruthy();
    const mine = (await call('GET', `/v1/support/tickets/${ticket}`, customer)).json();
    expect(mine.messages.map((m: { text: string }) => m.text)).toEqual(['I ordered black but got tan.', 'So sorry! We are sending the right one.']);
    expect(mine.messages[1].by).toBe('ShopCore support');
    const stranger = await h.token(uuidv7(), ['customer']);
    expect((await call('GET', `/v1/support/tickets/${ticket}`, stranger)).statusCode).toBe(404);
  });

  it('moves between waiting on staff and waiting on the customer, then resolves, rates and reopens', async () => {
    expect((await call('POST', `/v1/support/tickets/${ticket}/messages`, customer, { text: 'Thank you!' })).json().status).toBe('open');
    expect((await call('POST', `/v1/support/tickets/${ticket}/rating`, customer, { csat: 5 })).json().error.code).toBe('NOT_RESOLVED');
    const res = await call('POST', `/v1/admin/tickets/${ticket}/status`, grace, { status: 'resolved' });
    expect(res.json()).toMatchObject({ status: 'resolved' });
    expect((await call('POST', `/v1/support/tickets/${ticket}/rating`, customer, { csat: 5 })).json().csat).toBe(5);
    expect((await call('POST', `/v1/support/tickets/${ticket}/rating`, customer, { csat: 1 })).json().error.code).toBe('ALREADY_RATED');
    expect((await call('POST', `/v1/support/tickets/${ticket}/messages`, customer, { text: 'Actually, it came broken too.' })).json().status).toBe('open');
    expect((await call('GET', '/v1/support/tickets', customer)).json().items).toHaveLength(1);
  });

  it('flags tickets that have waited too long for a first reply', async () => {
    const r = await call('POST', '/v1/admin/tickets', grace, { personId: wanjiku, subject: 'Phone call: missing item', priority: 'urgent' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ assignee: 'Grace', breached: false });
    await h.db.query(`UPDATE tickets SET created_at = now() - interval '2 hours' WHERE id = $1`, [r.json().id]);
    expect((await call('GET', '/v1/admin/tickets?sla=breached', grace)).json().items.map((t: { id: string }) => t.id)).toEqual([r.json().id]);
    expect((await call('GET', '/v1/admin/tickets?assignee=me&status=open', grace)).json().items.length).toBeGreaterThan(0);
    const staffList = (await call('GET', '/v1/admin/agents', grace)).statusCode; // not a route
    expect(staffList).toBe(404);
    const agents = (await call('GET', '/v1/admin/support/agents', grace)).json().items as { id: string; name: string }[];
    expect(agents.map((a) => a.name)).toContain('Grace');
    const me = agents.find((a) => a.name === 'Grace')!;
    expect((await call('POST', `/v1/admin/tickets/${r.json().id}/assign`, grace, { assigneeId: null })).json().assignee).toBeNull();
    expect((await call('GET', '/v1/admin/tickets?assignee=none', grace)).json().items).toHaveLength(1);
    expect((await call('POST', `/v1/admin/tickets/${r.json().id}/assign`, grace, { assigneeId: me.id })).json().assignee).toBe('Grace');
    expect((await call('POST', `/v1/admin/tickets/${r.json().id}/status`, grace, { status: 'escalated', priority: 'urgent' })).json().status).toBe('escalated');
    expect((await call('GET', '/v1/admin/tickets', ruth)).statusCode).toBe(403);
  });

  it('gives riders their own support line', async () => {
    await call('POST', '/v1/rider/auth/code', null, { phone: '+254711999001', purpose: 'signup' });
    await call('POST', '/v1/rider/auth/verify', null, { phone: '+254711999001', purpose: 'signup', code: '123456' });
    const reg = (await call('POST', '/v1/rider/auth/register', null, { phone: '+254711999001', password: 'Ride1234', name: 'Wanjala Rider' })).json();
    const t = await call('POST', '/v1/rider/support/tickets', reg.accessToken, { subject: 'My payout is late', category: 'Payments', message: 'Requested on Monday.' });
    expect(t.statusCode).toBe(201);
    expect((await call('GET', '/v1/admin/tickets?kind=rider', grace)).json().items[0]).toMatchObject({ kind: 'rider', person: 'Wanjala Rider' });
    expect((await call('GET', '/v1/rider/support/tickets', reg.accessToken)).json().items).toHaveLength(1);
    expect((await call('GET', `/v1/support/tickets/${t.json().id}`, customer)).statusCode).toBe(404);
  });
});

describe('live chat', () => {
  it('queues a customer message, clears it when an agent opens it, and keeps one open chat per customer', async () => {
    const buyer = uuidv7();
    const t = await h.token(buyer, ['customer']);
    expect((await call('GET', '/v1/support/chat', t)).json().chat).toBeNull();
    await call('POST', '/v1/support/chat/messages', t, { text: 'Hello? Is anyone there?' });
    await call('POST', '/v1/support/chat/messages', t, { text: 'My order is late.' });
    const q = (await call('GET', '/v1/admin/chats', grace)).json().items as { id: string; unread: number; assignee: string | null; lastMessage: string }[];
    const chat = q.find((c) => c.unread === 2)!;
    expect(chat).toMatchObject({ assignee: null, lastMessage: 'My order is late.' });
    const opened = (await call('GET', `/v1/admin/chats/${chat.id}`, grace)).json();
    expect(opened.messages).toHaveLength(2);
    expect((await call('GET', '/v1/admin/chats', grace)).json().items.find((c: { id: string }) => c.id === chat.id).unread).toBe(0);
    const sent = await call('POST', `/v1/admin/chats/${chat.id}/messages`, grace, { text: 'Hi! Let me look.' });
    expect(sent.json()).toMatchObject({ assignee: 'Grace' });
    const mine = (await call('GET', '/v1/support/chat', t)).json().chat;
    expect(mine.messages.map((m: { text: string }) => m.text)).toEqual(['Hello? Is anyone there?', 'My order is late.', 'Hi! Let me look.']);
    expect(mine.messages[2].by).toBe('Grace');
    expect((await call('POST', `/v1/admin/chats/${chat.id}/close`, grace)).statusCode).toBe(204);
    expect((await call('POST', `/v1/admin/chats/${chat.id}/messages`, grace, { text: 'Still there?' })).json().error.code).toBe('CHAT_CLOSED');
    expect((await call('GET', '/v1/support/chat', t)).json().chat).toBeNull();
    await call('POST', '/v1/support/chat/messages', t, { text: 'Me again' });
    expect((await call('GET', '/v1/admin/chats', grace)).json().items.filter((c: { customerId: string }) => c.customerId === buyer)).toHaveLength(1);
    expect((await call('GET', '/v1/admin/chats?state=closed', grace)).json().items).toHaveLength(1);
    expect((await call('GET', '/v1/admin/chats', ruth)).statusCode).toBe(403);
  });

  it('lets an agent start a chat with a customer', async () => {
    const c = await call('POST', '/v1/admin/chats', grace, { customerId: wanjiku });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ name: 'Wanjiku Njoroge', assignee: 'Grace' });
    expect((await call('POST', '/v1/admin/chats', grace, { customerId: wanjiku })).json().id).toBe(c.json().id);
  });
});

describe('reviews', () => {
  it('takes one review per delivered order, and lets the team reply and moderate', async () => {
    const pending = await order();
    expect((await call('POST', `/v1/orders/${pending.id}/review`, customer, { rating: 5 })).json().error.code).toBe('NOT_DELIVERED');
    const done = await order({ delivered: true });
    const r = await call('POST', `/v1/orders/${done.id}/review`, customer, { rating: 1, text: 'Arrived late and crushed.', topic: 'Delivery' });
    expect(r.statusCode).toBe(201);
    expect((await call('POST', `/v1/orders/${done.id}/review`, customer, { rating: 5 })).json().error.code).toBe('ALREADY_REVIEWED');
    const list = (await call('GET', '/v1/admin/reviews?complaints=true', grace)).json();
    expect(list.items[0]).toMatchObject({ rating: 1, complaint: true, checked: false, customer: 'Wanjiku Njoroge' });
    expect(list.summary).toMatchObject({ count: 1, average: 1, complaints: 1 });
    expect((await call('POST', `/v1/admin/reviews/${r.json().id}/reply`, grace, { text: 'We are sorry and will make it right.' })).statusCode).toBe(204);
    expect((await call('POST', `/v1/admin/reviews/${r.json().id}/state`, grace, { state: 'flagged' })).statusCode).toBe(204);
    expect((await call('GET', '/v1/admin/reviews?state=flagged&unchecked=false', grace)).json().items[0]).toMatchObject({ reply: 'We are sorry and will make it right.', repliedBy: 'Grace', checked: true });
  });
});

describe('refunds', () => {
  it('lets a shopper ask, once per order, and never for more than they paid', async () => {
    const o = await order({ qty: 1 });
    expect((await call('POST', `/v1/orders/${o.id}/refund-requests`, customer, { amountCents: 9_999_999, reason: 'Broken' })).json().error.code).toBe('MORE_THAN_PAID');
    const ok = await call('POST', `/v1/orders/${o.id}/refund-requests`, customer, { amountCents: 100_000, reason: 'Strap was torn' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'needs_review', amountCents: 100_000 });
    expect((await call('POST', `/v1/orders/${o.id}/refund-requests`, customer, { amountCents: 50_000, reason: 'Again' })).json().error.code).toBe('REFUND_OPEN');
    const stranger = await h.token(uuidv7(), ['customer']);
    expect((await call('POST', `/v1/orders/${o.id}/refund-requests`, stranger, { amountCents: 1_000, reason: 'Not mine' })).statusCode).toBe(404);
    const unpaid = await order({ pay: false });
    expect((await call('POST', `/v1/orders/${unpaid.id}/refund-requests`, customer, { amountCents: 1_000, reason: 'Nothing paid' })).json().error.code).toBe('NOT_PAID');

    const q = (await call('GET', '/v1/admin/refunds?status=needs_review', grace)).json();
    expect(q.limit).toBe(500_000);
    const r = q.items.find((x: { id: string }) => x.id === ok.json().id);
    // a small refund, partly approved by support
    const d = await call('POST', `/v1/admin/refunds/${r.id}/decision`, grace, { decision: 'approve', amountCents: 60_000, reason: 'Partial for the torn strap' });
    expect(d.json()).toMatchObject({ status: 'partly_approved', decision: { by: 'Grace', amountCents: 60_000 } });
    expect((await call('POST', `/v1/admin/refunds/${r.id}/decision`, grace, { decision: 'reject', reason: 'Too late' })).json().error.code).toBe('ALREADY_DECIDED');
    const od = (await call('GET', `/v1/admin/orders/${o.id}`, james)).json();
    expect(od.refundedCents).toBe(60_000);
    const ev = (await h.db.query(`SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'RefundApproved'`, [o.id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ amountCents: 60_000, method: 'mpesa' });
  });

  it('keeps large refunds for people with payments access, and never refunds more than is left', async () => {
    const o = await order({ qty: 3 }); // KES 14,550
    const req = await call('POST', `/v1/orders/${o.id}/refund-requests`, customer, { amountCents: o.totalCents, reason: 'Never arrived' });
    const id = req.json().id as string;
    const big = await call('POST', `/v1/admin/refunds/${id}/decision`, grace, { decision: 'approve', amountCents: o.totalCents, reason: 'Never arrived' });
    expect(big.statusCode).toBe(403);
    expect(big.json().error.message).toContain('payments access');
    expect((await call('POST', `/v1/admin/refunds/${id}/notes`, grace, { text: 'Over my limit: asking finance' })).json().notes).toHaveLength(1);
    expect((await call('POST', `/v1/admin/refunds/${id}/decision`, samuel, { decision: 'approve', amountCents: o.totalCents + 1, reason: 'x y z' })).json().error.code).toBe('MORE_THAN_PAID');
    const ok = await call('POST', `/v1/admin/refunds/${id}/decision`, samuel, { decision: 'approve', amountCents: o.totalCents, reason: 'Confirmed lost' });
    expect(ok.json()).toMatchObject({ status: 'approved', decision: { by: 'Samuel' } });
    const again = await call('POST', '/v1/admin/refunds', grace, { orderId: o.id, amountCents: 1_000, reason: 'Extra goodwill' });
    expect(again.json().error.code).toBe('MORE_THAN_PAID'); // fully refunded already
  });

  it('records a rejection with the reason, and is closed to roles without Claims', async () => {
    const o = await order();
    const r = await call('POST', '/v1/admin/refunds', grace, { orderId: o.id, amountCents: 50_000, reason: 'Phone call: says it never came' });
    expect(r.statusCode).toBe(201);
    expect((await call('POST', `/v1/admin/refunds/${r.json().id}/decision`, grace, { decision: 'reject', reason: 'Rider photo shows it was delivered' })).json()).toMatchObject({ status: 'rejected', decision: { amountCents: 0, reason: 'Rider photo shows it was delivered' } });
    expect((await call('GET', '/v1/admin/refunds', ruth)).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/refunds', kevin)).statusCode).toBe(403);
    expect((await call('GET', '/v1/support/claims', customer)).json().refunds.length).toBeGreaterThan(0);
  });
});

describe('returns', () => {
  it('takes a return only for delivered items, inside the window, and sends approved ones to the warehouse', async () => {
    const o = await order({ qty: 2, delivered: true });
    const early = await order({ qty: 1 });
    expect((await call('POST', `/v1/orders/${early.id}/returns`, customer, { productId: product, reason: 'Changed mind' })).json().error.code).toBe('NOT_DELIVERED');
    expect((await call('POST', `/v1/orders/${o.id}/returns`, customer, { productId: uuidv7(), reason: 'Wrong item' })).statusCode).toBe(400);
    expect((await call('POST', `/v1/orders/${o.id}/returns`, customer, { productId: product, qty: 3, reason: 'Too many' })).json().error.code).toBe('ALREADY_RETURNED');
    const r = await call('POST', `/v1/orders/${o.id}/returns`, customer, { productId: product, qty: 1, reason: 'Arrived damaged', statement: 'Zip is broken', photos: 2 });
    expect(r.statusCode).toBe(201);
    const q = (await call('GET', '/v1/admin/returns?open=true', grace)).json().items as { id: string; status: string; itemValueCents: number; photos: number }[];
    expect(q[0]).toMatchObject({ status: 'new', itemValueCents: 485_000, photos: 2 });

    expect((await call('POST', `/v1/admin/returns/${r.json().id}/decision`, grace, { decision: 'evidence_requested', note: 'Please send a photo of the zip' })).json().status).toBe('evidence_requested');
    expect((await call('GET', '/v1/support/claims', customer)).json().returns[0]).toMatchObject({ status: 'evidence_requested', message: 'Please send a photo of the zip' });
    const ok = await call('POST', `/v1/admin/returns/${r.json().id}/decision`, grace, { decision: 'approved', note: 'Photo confirms damage' });
    expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: 'Grace' });
    expect((await call('POST', `/v1/admin/returns/${r.json().id}/decision`, grace, { decision: 'rejected', note: 'Changed my mind' })).json().error.code).toBe('ALREADY_DECIDED');

    const wh = (await call('GET', '/v1/admin/warehouse-returns', kevin)).json().items as { product: string; qty: number; condition: string; reason: string; valueCents: number }[];
    expect(wh).toEqual([expect.objectContaining({ product: 'Leather Tote', qty: 1, condition: 'Photo evidence', reason: 'Arrived damaged', valueCents: 485_000 })]);
  });

  it('refuses a return after the window', async () => {
    const o = await order({ delivered: true });
    await h.db.query(`UPDATE orders SET fulfilled_at = now() - interval '20 days' WHERE id = $1`, [o.id]);
    expect((await call('POST', `/v1/orders/${o.id}/returns`, customer, { productId: product, reason: 'Late' })).json().error.code).toBe('RETURN_WINDOW_PASSED');
  });
});

describe('disputes', () => {
  it('opens, escalates and resolves for the customer, opening the refund that is owed', async () => {
    const o = await order();
    const d = await call('POST', '/v1/admin/disputes', grace, { orderId: o.id, category: 'Delivery location', customerStatement: 'Never received it', riderStatement: 'Left it with the guard' });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ status: 'awaiting_decision', rider: 'Unassigned', claimBy: 'customer', late: false });
    expect(d.json().number).toMatch(/^DSP-/);
    expect((await call('POST', '/v1/admin/disputes', grace, { orderId: o.id })).json().error.code).toBe('DISPUTE_OPEN');
    const up = await call('PATCH', `/v1/admin/disputes/${d.json().id}`, grace, { notes: 'Guard has no record', evidence: 'Doorman log requested' });
    expect(up.json().evidence).toHaveLength(2);
    expect((await call('POST', `/v1/admin/disputes/${d.json().id}/escalate`, grace)).json().status).toBe('escalated');
    expect((await call('POST', `/v1/admin/disputes/${d.json().id}/escalate`, grace)).json().error.code).toBe('CANNOT_ESCALATE');
    const res = await call('POST', `/v1/admin/disputes/${d.json().id}/resolve`, grace, { inFavourOf: 'customer', note: 'Delivered to the wrong block', openRefund: true });
    expect(res.json()).toMatchObject({ status: 'resolved_customer', outcome: { by: 'Grace' } });
    const refunds = (await call('GET', `/v1/admin/refunds?orderId=${o.id}`, grace)).json().items as { status: string; amountCents: number; reason: string }[];
    expect(refunds).toEqual([expect.objectContaining({ status: 'needs_review', amountCents: o.totalCents })]);
    expect(refunds[0]!.reason).toContain('DSP-');
    expect((await call('PATCH', `/v1/admin/disputes/${d.json().id}`, grace, { notes: 'edit' })).json().error.code).toBe('ALREADY_RESOLVED');
    expect((await call('POST', `/v1/admin/disputes/${d.json().id}/resolve`, grace, { inFavourOf: 'rider', note: 'Changed my mind' })).json().error.code).toBe('ALREADY_RESOLVED');
    expect((await call('GET', '/v1/admin/disputes', ruth)).statusCode).toBe(403);
  });
});

describe('overview', () => {
  it('summarises the desk', async () => {
    const o = (await call('GET', '/v1/admin/support/overview', grace)).json();
    expect(o.tickets.open).toBeGreaterThan(0);
    expect(o.tickets.breached).toBe(1);
    expect(o.tickets.csat).toBe(5);
    expect(o.claims).toMatchObject({ refundsToReview: expect.any(Number), openDisputes: 0 });
    expect(o.reviews).toMatchObject({ flagged: 1 });
    expect((await call('GET', '/v1/admin/support/overview', ruth)).statusCode).toBe(403);
  });
});

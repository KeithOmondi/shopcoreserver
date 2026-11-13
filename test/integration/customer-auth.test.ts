import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, idemKey, resetDatabase, type Harness } from '../helpers.js';

let h: Harness;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (url: string, body: unknown) => call('POST', url, null, body);
const OTP = '482913';
const joe = { fullName: 'Amina Wanjiku', email: 'Amina@Example.com', phone: '0712 345 678', password: 'sunrise2025' };

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: OTP });
  await h.c.staff.ensureDefaultRoles();
});
afterAll(async () => { await h.close(); });
const lapse = () => h.db.query(`UPDATE customer_signups SET sent_at = now() - interval '1 minute'; UPDATE customer_resets SET sent_at = now() - interval '1 minute'`);

describe('joining', () => {
  it('needs the code from the phone before an account exists, then signs the person in', async () => {
    expect((await post('/v1/customer/auth/signup', { ...joe, password: 'short' })).statusCode).toBe(400);
    expect((await post('/v1/customer/auth/signup', { ...joe, phone: '0212345678' })).statusCode).toBe(400);
    const s = await post('/v1/customer/auth/signup', joe);
    expect(s.statusCode).toBe(202);
    expect((await h.db.query('SELECT count(*)::int AS n FROM customer_accounts')).rows[0].n).toBe(0);
    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).statusCode).toBe(401);

    const wrong = await post('/v1/customer/auth/verify-signup', { phone: '+254712345678', code: '000000' });
    expect(wrong.json().error.code).toBe('WRONG_CODE');
    const ok = await post('/v1/customer/auth/verify-signup', { phone: '0712345678', code: OTP });
    expect(ok.statusCode).toBe(201);
    const t = ok.json();
    expect(t.user).toMatchObject({ fullName: 'Amina Wanjiku', email: 'amina@example.com', phone: '+254712345678' });
    expect(t.accessToken).toBeTruthy();
    expect(t.refreshToken).toBeTruthy();
    // The code only works once.
    expect((await post('/v1/customer/auth/verify-signup', { phone: '+254712345678', code: OTP })).json().error.code).toBe('CODE_EXPIRED');

    expect((await call('GET', '/v1/customer/me', t.accessToken)).json()).toMatchObject({ fullName: 'Amina Wanjiku', phone: '+254712345678' });
    expect((await call('GET', '/v1/customer/me', null)).statusCode).toBe(401);
  });

  it('says plainly when the email or number is taken, and slows down repeated codes', async () => {
    const dupe = await post('/v1/customer/auth/signup', { ...joe, phone: '0722 000 111' });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error).toMatchObject({ code: 'EMAIL_EXISTS', details: { field: 'email' } });
    expect((await post('/v1/customer/auth/signup', { ...joe, email: 'other@example.com' })).json().error.code).toBe('PHONE_EXISTS');
    const fresh = { fullName: 'Brian Otieno', email: 'brian@example.com', phone: '0733 111 222', password: 'sunrise2025' };
    expect((await post('/v1/customer/auth/signup', fresh)).statusCode).toBe(202);
    expect((await post('/v1/customer/auth/signup', fresh)).json().error.code).toBe('CODE_TOO_SOON');
    expect((await post('/v1/customer/auth/resend', { phone: fresh.phone })).json().error.code).toBe('CODE_TOO_SOON');
    await lapse();
    expect((await post('/v1/customer/auth/resend', { phone: fresh.phone })).statusCode).toBe(204);
    expect((await post('/v1/customer/auth/resend', { phone: '0744 999 888' })).statusCode).toBe(404);
    // Five wrong codes lock this attempt.
    for (let i = 0; i < 5; i++) await post('/v1/customer/auth/verify-signup', { phone: fresh.phone, code: '111111' });
    expect((await post('/v1/customer/auth/verify-signup', { phone: fresh.phone, code: OTP })).json().error.code).toBe('CODE_LOCKED');
  });
});

describe('coming back', () => {
  it('signs in with the email or the number, and locks after repeated wrong passwords', async () => {
    const a = await post('/v1/customer/auth/login', { identifier: 'AMINA@example.com', password: joe.password });
    expect(a.statusCode).toBe(200);
    const b = await post('/v1/customer/auth/login', { identifier: '+254 712 345 678', password: joe.password });
    expect(b.statusCode).toBe(200);
    expect(b.json().user.id).toBe(a.json().user.id);
    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: 'nope' })).json().error.message).toBe('Incorrect email, phone number or password');
    expect((await post('/v1/customer/auth/login', { identifier: 'ghost@example.com', password: 'nope' })).json().error.message).toBe('Incorrect email, phone number or password');
    for (let i = 0; i < 4; i++) await post('/v1/customer/auth/login', { identifier: joe.email, password: 'nope' });
    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).json().error.code).toBe('ACCOUNT_LOCKED');
    await h.db.query(`UPDATE customer_accounts SET locked_until = NULL, failed_attempts = 0`);
  });

  it('rotates the refresh token, treats a reused one as theft, and ends the session on logout', async () => {
    const t = (await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).json();
    const next = await post('/v1/customer/auth/refresh', { refreshToken: t.refreshToken });
    expect(next.statusCode).toBe(200);
    expect(next.json().refreshToken).not.toBe(t.refreshToken);
    expect((await post('/v1/customer/auth/refresh', { refreshToken: t.refreshToken })).statusCode).toBe(401);
    expect((await post('/v1/customer/auth/refresh', { refreshToken: next.json().refreshToken })).statusCode).toBe(401); // the whole family is dead
    const u = (await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).json();
    expect((await call('POST', '/v1/customer/auth/logout', u.accessToken)).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/me', u.accessToken)).statusCode).toBe(401);
    expect((await post('/v1/customer/auth/refresh', { refreshToken: u.refreshToken })).statusCode).toBe(401);
  });

  it('works as the same shopper everywhere else in the API', async () => {
    const t = (await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).json();
    const prefs = await call('PUT', '/v1/me/marketing', t.accessToken, { push: true, email: false, sms: true });
    expect(prefs.json()).toMatchObject({ push: true, sms: true });
    const p = (await call('POST', '/v1/admin/products', await staff(), { sku: 'T-1', name: 'Tote', priceCents: 100_000, currency: 'KES', initialStock: 10 })).json();
    const order = await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${t.accessToken}`, 'idempotency-key': idemKey() }, payload: { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'mpesa' } });
    expect(order.statusCode).toBe(201);
    expect(order.json().userId).toBe(t.user.id);
  });
});

async function staff() {
  await h.c.staff.insertRaw({ name: 'Kevin', email: 'kevin@t.co', role: 'Inventory manager', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'kevin@t.co', password: 'Sunrise#2025!' } });
  return r.json().accessToken as string;
}

describe('forgotten passwords', () => {
  it('sends a code, trades it for a one-time token, then sets the new password and ends every session', async () => {
    const open = (await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).json();
    // Asking about an account that doesn't exist looks exactly the same.
    const ghost = await post('/v1/customer/auth/forgot', { identifier: 'ghost@example.com' });
    const real = await post('/v1/customer/auth/forgot', { identifier: joe.email });
    expect(ghost.statusCode).toBe(202);
    expect(real.statusCode).toBe(202);
    expect(ghost.json()).toEqual(real.json());

    expect((await post('/v1/customer/auth/verify-reset', { identifier: joe.email, code: '000000' })).json().error.code).toBe('WRONG_CODE');
    const v = await post('/v1/customer/auth/verify-reset', { identifier: '0712345678', code: OTP });
    expect(v.statusCode).toBe(200);
    const { resetToken } = v.json();
    expect((await post('/v1/customer/auth/verify-reset', { identifier: joe.email, code: OTP })).json().error.code).toBeTruthy(); // the code is spent
    expect((await post('/v1/customer/auth/reset', { resetToken: 'x'.repeat(30), password: 'brandnew123' })).json().error.code).toBe('RESET_EXPIRED');
    expect((await post('/v1/customer/auth/reset', { resetToken, password: 'short' })).statusCode).toBe(400);
    expect((await post('/v1/customer/auth/reset', { resetToken, password: 'brandnew123' })).statusCode).toBe(204);
    expect((await post('/v1/customer/auth/reset', { resetToken, password: 'another12345' })).json().error.code).toBe('RESET_EXPIRED');

    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: joe.password })).statusCode).toBe(401);
    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: 'brandnew123' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/customer/me', open.accessToken)).statusCode).toBe(401);
  });
});

describe('the account itself', () => {
  it('edits the profile, changes the password, and deletes the account when nothing is on its way', async () => {
    const t = (await post('/v1/customer/auth/login', { identifier: joe.email, password: 'brandnew123' })).json();
    expect((await call('PATCH', '/v1/customer/me', t.accessToken, { fullName: 'Amina W. Njeri' })).json()).toMatchObject({ fullName: 'Amina W. Njeri', email: 'amina@example.com' });
    expect((await call('PATCH', '/v1/customer/me', t.accessToken, {})).statusCode).toBe(400);
    await post('/v1/customer/auth/signup', { fullName: 'Chris K', email: 'chris@example.com', phone: '0755 000 111', password: 'sunrise2025' });
    await post('/v1/customer/auth/verify-signup', { phone: '0755000111', code: OTP });
    expect((await call('PATCH', '/v1/customer/me', t.accessToken, { email: 'chris@example.com' })).json().error.code).toBe('EMAIL_EXISTS');

    expect((await call('POST', '/v1/customer/me/password', t.accessToken, { currentPassword: 'wrong', newPassword: 'newer12345' })).json().error.code).toBe('WRONG_PASSWORD');
    expect((await call('POST', '/v1/customer/me/password', t.accessToken, { currentPassword: 'brandnew123', newPassword: 'newer12345' })).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/me', t.accessToken)).statusCode).toBe(200); // this session stays signed in

    expect((await call('POST', '/v1/customer/me/delete', t.accessToken, { password: 'wrong' })).json().error.code).toBe('WRONG_PASSWORD');
    expect((await call('POST', '/v1/customer/me/delete', t.accessToken, { password: 'newer12345' })).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/me', t.accessToken)).statusCode).toBe(401);
    expect((await post('/v1/customer/auth/login', { identifier: joe.email, password: 'newer12345' })).statusCode).toBe(401);
    expect((await h.db.query(`SELECT name, email, phone FROM customers WHERE id = $1`, [t.user.id])).rows[0]).toEqual({ name: 'Deleted customer', email: '', phone: '' });
    // The email and number are free to join again.
    expect((await post('/v1/customer/auth/signup', joe)).statusCode).toBe(202);
  });
});

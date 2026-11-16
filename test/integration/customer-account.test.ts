import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness } from '../helpers.js';

let h: Harness;
const OTP = '482913';
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string | null, body?: unknown) =>
  h.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (url: string, body: unknown) => call('POST', url, null, body);
const join = async (name: string, email: string, phone: string) => {
  await post('/v1/customer/auth/signup', { fullName: name, email, phone, password: 'sunrise2025' });
  return (await post('/v1/customer/auth/verify-signup', { phone, code: OTP })).json().accessToken as string;
};
const addr = (over: Record<string, unknown> = {}) => ({ label: 'Home', fullName: 'Wanjiru Kamau', phone: '0712 345 678', county: 'Nairobi', area: 'Kilimani', street: 'Argwings Kodhek Rd, Apt 4', ...over });

let token: string, owner: string;
beforeAll(async () => {
  await resetDatabase();
  h = await createHarness({ CUSTOMER_DEV_OTP: OTP });
  await h.c.staff.ensureDefaultRoles();
  await h.c.staff.insertRaw({ name: 'Amara', email: 'amara@t.co', role: 'Owner admin', status: 'active', password: 'Sunrise#2025!', mustChange: false });
  owner = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'amara@t.co', password: 'Sunrise#2025!' } })).json().accessToken;
  await call('POST', '/v1/admin/zones', owner, { name: 'Kilimani', feeCents: 25_000, areas: ['Kilimani', 'Lavington'] });
  await call('POST', '/v1/admin/zones', owner, { name: 'Mombasa Island', county: 'Mombasa', feeCents: 40_000, areas: ['Nyali'] });
  await call('PUT', '/v1/admin/delivery-settings', owner, { baseFeeCents: 30_000, minBasketCents: 50_000 });
  token = await join('Wanjiru K', 'wanjiru@example.com', '0766000111');
});
afterAll(async () => { await h.close(); });

describe('delivery areas', () => {
  it('lists the places the shop delivers to, by county, with fees, without signing in', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/v1/delivery/areas' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('public');
    expect(r.json()).toEqual({
      counties: [
        { county: 'Mombasa', areas: [{ name: 'Nyali', zone: 'Mombasa Island', feeCents: 40_000 }] },
        { county: 'Nairobi', areas: [{ name: 'Kilimani', zone: 'Kilimani', feeCents: 25_000 }, { name: 'Lavington', zone: 'Kilimani', feeCents: 25_000 }] },
      ],
      baseFeeCents: 30_000, minBasketCents: 50_000,
    });
  });
});

describe('the address book', () => {
  it('saves addresses only for served areas, makes the first one the default, and keeps one default', async () => {
    expect((await call('GET', '/v1/customer/addresses', null)).statusCode).toBe(401);
    expect((await call('POST', '/v1/customer/addresses', token, addr({ area: 'Karen' }))).json().error.code).toBe('AREA_NOT_SERVED');
    expect((await call('POST', '/v1/customer/addresses', token, addr({ county: 'Mombasa', area: 'Kilimani' }))).json().error.code).toBe('AREA_NOT_SERVED');
    expect((await call('POST', '/v1/customer/addresses', token, addr({ phone: '0212345678' }))).statusCode).toBe(400);
    expect((await call('POST', '/v1/customer/addresses', token, addr({ street: 'x' }))).statusCode).toBe(400);

    const home = await call('POST', '/v1/customer/addresses', token, addr({ area: 'kilimani' }));
    expect(home.statusCode).toBe(201);
    expect(home.json()).toMatchObject({ label: 'Home', area: 'Kilimani', county: 'Nairobi', phone: '+254712345678', isDefault: true });
    const work = (await call('POST', '/v1/customer/addresses', token, addr({ label: 'Work', area: 'Lavington', street: 'Lenana Rd, 3rd floor' }))).json();
    expect(work.isDefault).toBe(false);
    expect((await call('PATCH', `/v1/customer/addresses/${work.id}`, token, { isDefault: true })).json().isDefault).toBe(true);
    const list = (await call('GET', '/v1/customer/addresses', token)).json().items;
    expect(list.map((a: { label: string; isDefault: boolean }) => [a.label, a.isDefault])).toEqual([['Work', true], ['Home', false]]);

    // Editing one field leaves the rest alone; moving to an unserved area is refused.
    expect((await call('PATCH', `/v1/customer/addresses/${home.json().id}`, token, { street: 'New building, Apt 9' })).json()).toMatchObject({ street: 'New building, Apt 9', area: 'Kilimani', phone: '+254712345678', label: 'Home' });
    expect((await call('PATCH', `/v1/customer/addresses/${home.json().id}`, token, { area: 'Karen' })).json().error.code).toBe('AREA_NOT_SERVED');

    // Deleting the default hands it to the one that's left.
    expect((await call('DELETE', `/v1/customer/addresses/${work.id}`, token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/customer/addresses', token)).json().items).toEqual([expect.objectContaining({ label: 'Home', isDefault: true })]);
    expect((await call('DELETE', `/v1/customer/addresses/${work.id}`, token)).statusCode).toBe(404);
  });

  it('stops at ten addresses', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await call('POST', '/v1/customer/addresses', token, addr({ label: 'Other', street: `Street number ${i + 10}` }))).json().id);
    expect((await call('POST', '/v1/customer/addresses', token, addr({ label: 'Other', street: 'One too many' }))).json().error.code).toBe('TOO_MANY_ADDRESSES');
    for (const id of ids) await call('DELETE', `/v1/customer/addresses/${id}`, token);
  });

  it('keeps addresses private to their owner', async () => {
    const mine = (await call('POST', '/v1/customer/addresses', token, addr({ label: 'Other', street: 'Private street 1' }))).json();
    const theirs = await join('Someone Else', 'else@example.com', '0777000222');
    expect((await call('GET', '/v1/customer/addresses', theirs)).json().items).toEqual([]);
    expect((await call('PATCH', `/v1/customer/addresses/${mine.id}`, theirs, { street: 'Stolen street' })).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/customer/addresses/${mine.id}`, theirs)).statusCode).toBe(404);
  });
});

describe('preferences and profile', () => {
  it('remembers notification choices: orders on by default, marketing off until asked', async () => {
    expect((await call('GET', '/v1/customer/preferences', token)).json()).toEqual({ orders: true, returns: true, deals: false, stock: false, recs: false, push: false, email: false, sms: false, language: 'en' });
    const set = await call('PATCH', '/v1/customer/preferences', token, { deals: true, push: true, returns: false });
    expect(set.json()).toEqual({ orders: true, returns: false, deals: true, stock: false, recs: false, push: true, email: false, sms: false, language: 'en' });
    expect((await call('PATCH', '/v1/customer/preferences', token, {})).statusCode).toBe(400);
    // The marketing audience sees the channel choice.
    expect((await call('GET', '/v1/me/marketing', token)).json()).toMatchObject({ push: true, email: false, sms: false });
  });

  it('edits the profile and its birth date, and changes the phone number only with a code', async () => {
    expect((await call('PATCH', '/v1/customer/me', token, { dob: { day: 12, month: 3, year: 1995 }, fullName: 'Wanjiru Kamau' })).json()).toMatchObject({ fullName: 'Wanjiru Kamau', dob: { day: 12, month: 3, year: 1995 } });
    expect((await call('PATCH', '/v1/customer/me', token, { dob: { day: 31, month: 2, year: 1995 } })).json().error.code).toBe('BAD_DATE');
    expect((await call('PATCH', '/v1/customer/me', token, { fullName: 'Wanjiru K.' })).json().dob).toEqual({ day: 12, month: 3, year: 1995 });
    expect((await call('PATCH', '/v1/customer/me', token, { dob: null })).json().dob).toBeNull();

    expect((await call('POST', '/v1/customer/me/phone', token, { phone: '0777 000 222' })).json().error.code).toBe('PHONE_EXISTS');
    expect((await call('POST', '/v1/customer/me/phone/verify', token, { code: OTP })).json().error.code).toBe('CODE_EXPIRED');
    expect((await call('POST', '/v1/customer/me/phone', token, { phone: '0788 123 456' })).statusCode).toBe(202);
    expect((await call('POST', '/v1/customer/me/phone/verify', token, { code: '000000' })).json().error.code).toBe('WRONG_CODE');
    expect((await call('GET', '/v1/customer/me', token)).json().phone).toBe('+254766000111'); // not switched yet
    expect((await call('POST', '/v1/customer/me/phone/verify', token, { code: OTP })).json().phone).toBe('+254788123456');
    expect((await post('/v1/customer/auth/login', { identifier: '0788123456', password: 'sunrise2025' })).statusCode).toBe(200);
    expect((await post('/v1/customer/auth/login', { identifier: '0766000111', password: 'sunrise2025' })).statusCode).toBe(401);
  });
});

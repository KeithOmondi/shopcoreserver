import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness } from '../helpers.js';

const PW = 'Sunrise#2025!';
let h: Harness;

const post = (url: string, body: unknown, token?: string) =>
  h.app.inject({ method: 'POST', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const get = (url: string, token?: string) => h.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
const patch = (url: string, body: unknown, token: string) => h.app.inject({ method: 'PATCH', url, payload: body as object, headers: { authorization: `Bearer ${token}` } });
const del = (url: string, token: string) => h.app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } });

async function signIn(email: string, password = PW) {
  const r = await post('/v1/auth/login', { email, password });
  return { res: r, body: r.json() as { accessToken: string; refreshToken: string; mustChangePassword: boolean; staff: { id: string; role: string } } };
}
const tokenFor = async (email: string) => {
  const { res, body } = await signIn(email);
  if (res.statusCode !== 200) throw new Error(`sign-in failed for ${email}: ${res.body}`);
  return body.accessToken;
};

beforeAll(async () => {
  await resetDatabase();
  h = await createHarness();
  const s = h.c.staff;
  await s.ensureDefaultRoles();
  const add = (name: string, email: string, role: string, mustChange = false) =>
    s.insertRaw({ name, email, role, status: mustChange ? 'invited' : 'active', password: PW, mustChange });
  await add('Amara Owner', 'amara@t.co', 'Owner admin');
  await add('Second Owner', 'owner2@t.co', 'Owner admin');
  await add('Brian IT', 'brian@t.co', 'IT support');
  await add('Grace Support', 'grace@t.co', 'Customer support');
  await add('Samuel Finance', 'samuel@t.co', 'Finance analyst');
  await add('Ruth Marketing', 'ruth@t.co', 'Marketing manager');
  await add('Kevin Inventory', 'kevin@t.co', 'Inventory manager');
  await add('David New', 'david@t.co', 'Finance analyst', true);
});
afterAll(async () => { await h.close(); });

describe('sign in', () => {
  it('gives the same answer for a wrong password and an unknown email', async () => {
    const a = await signIn('grace@t.co', 'Wrong#Pass123');
    const b = await signIn('nobody@t.co', 'Wrong#Pass123');
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.body).toMatchObject({ error: { message: 'Incorrect email or password' } });
    expect(b.body).toMatchObject({ error: { message: 'Incorrect email or password' } });
  });

  it('returns the person, their permissions and tokens', async () => {
    const { res, body } = await signIn('Grace@T.co');
    expect(res.statusCode).toBe(200);
    expect(body.mustChangePassword).toBe(false);
    expect(body.staff).toMatchObject({ role: 'Customer support', permissions: { Support: [true, true, true, false, true], Payments: [false, false, false, false, false] } });
    const me = await get('/v1/me', body.accessToken);
    expect(me.statusCode).toBe(200);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) await signIn('ruth@t.co', 'Wrong#Pass123');
    const r = await signIn('ruth@t.co');
    expect(r.res.statusCode).toBe(429);
    expect(r.body).toMatchObject({ error: { code: 'ACCOUNT_LOCKED' } });
    await h.db.query(`UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE email = 'ruth@t.co'`);
    expect((await signIn('ruth@t.co')).res.statusCode).toBe(200);
  });

  it('forces a temporary password to be replaced before anything else', async () => {
    const { body } = await signIn('david@t.co');
    expect(body.mustChangePassword).toBe(true);
    const blocked = await get('/v1/staff', body.accessToken);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await get('/v1/me', body.accessToken)).statusCode).toBe(200);

    const weak = await post('/v1/auth/change-password', { currentPassword: PW, newPassword: 'short' }, body.accessToken);
    expect(weak.statusCode).toBe(422);
    const same = await post('/v1/auth/change-password', { currentPassword: PW, newPassword: PW }, body.accessToken);
    expect(same.json().error.code).toBe('PASSWORD_REUSED');
    const wrong = await post('/v1/auth/change-password', { currentPassword: 'Nope#Nope123', newPassword: 'Brand#New2026x' }, body.accessToken);
    expect(wrong.json().error.code).toBe('WRONG_PASSWORD');

    const ok = await post('/v1/auth/change-password', { currentPassword: PW, newPassword: 'Brand#New2026x' }, body.accessToken);
    expect(ok.statusCode).toBe(200);
    const fresh = ok.json().accessToken as string;
    expect((await get('/v1/roles', fresh)).statusCode).toBe(403); // finance can't see roles, but is no longer blocked by the change
    expect((await get('/v1/roles', fresh)).json().error.code).toBe('FORBIDDEN');
    expect((await signIn('david@t.co', 'Brand#New2026x')).res.statusCode).toBe(200);
    expect((await signIn('david@t.co')).res.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and shuts the family down if an old one is replayed', async () => {
    const { body } = await signIn('grace@t.co');
    const r1 = await post('/v1/auth/refresh', { refreshToken: body.refreshToken });
    expect(r1.statusCode).toBe(200);
    const next = r1.json() as { refreshToken: string; accessToken: string };
    expect(next.refreshToken).not.toBe(body.refreshToken);
    expect((await get('/v1/me', next.accessToken)).statusCode).toBe(200);

    const replay = await post('/v1/auth/refresh', { refreshToken: body.refreshToken });
    expect(replay.statusCode).toBe(401);
    // the copy that was stolen also ends the legitimate chain
    expect((await post('/v1/auth/refresh', { refreshToken: next.refreshToken })).statusCode).toBe(401);
  });

  it('stops working after sign out', async () => {
    const { body } = await signIn('grace@t.co');
    expect((await post('/v1/auth/logout', {}, body.accessToken)).statusCode).toBe(204);
    expect((await get('/v1/me', body.accessToken)).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { refreshToken: body.refreshToken })).statusCode).toBe(401);
  });

  it('rejects a staff-looking token that was never issued by a sign-in', async () => {
    const forged = await h.token('0190a1b2-0000-7000-8000-000000000001', ['staff']);
    expect((await get('/v1/me', forged)).statusCode).toBe(403);
  });
});

describe('who can manage staff', () => {
  it('lets IT support create an account and shows the temporary password once', async () => {
    const it = await tokenFor('brian@t.co');
    const r = await post('/v1/staff', { name: 'Newton Hire', email: 'Newton@T.co', phone: '+254 700 000 000', role: 'Dispatch manager' }, it);
    expect(r.statusCode).toBe(201);
    const { staff, temporaryPassword } = r.json();
    expect(staff).toMatchObject({ email: 'newton@t.co', status: 'invited', mustChangePassword: true });
    expect(JSON.stringify(staff)).not.toContain('password');
    expect(temporaryPassword).toMatch(/^.{12}$/);
    const first = await signIn('newton@t.co', temporaryPassword);
    expect(first.body.mustChangePassword).toBe(true);
    expect((await post('/v1/staff', { name: 'Dup', email: 'newton@t.co', role: 'Dispatch manager' }, it)).json().error.code).toBe('EMAIL_EXISTS');
    expect((await post('/v1/staff', { name: 'X', email: 'x@t.co', role: 'Made Up' }, it)).statusCode).toBe(400);
  });

  it('refuses everyone else, including finance and support', async () => {
    for (const who of ['grace@t.co', 'samuel@t.co', 'kevin@t.co']) {
      const t = await tokenFor(who);
      expect((await post('/v1/staff', { name: 'Z', email: `z-${who}`, role: 'Customer support' }, t)).statusCode).toBe(403);
      expect((await get('/v1/staff', t)).statusCode).toBe(403);
    }
  });

  it('keeps owners out of reach of IT support', async () => {
    const it = await tokenFor('brian@t.co');
    const owners = (await get('/v1/staff?role=Owner%20admin', it)).json().items as { id: string }[];
    expect(owners.length).toBe(2);
    expect((await post(`/v1/staff/${owners[0]!.id}/reset-password`, {}, it)).statusCode).toBe(403);
    expect((await patch(`/v1/staff/${owners[0]!.id}`, { status: 'suspended' }, it)).statusCode).toBe(403);
    const grace = (await get('/v1/staff?q=grace', it)).json().items[0] as { id: string };
    expect((await patch(`/v1/staff/${grace.id}`, { role: 'Owner admin' }, it)).statusCode).toBe(403);
  });

  it('does not let anyone change their own role or reset their own password for them', async () => {
    const it = await tokenFor('brian@t.co');
    const me = (await get('/v1/me', it)).json() as { id: string };
    expect((await patch(`/v1/staff/${me.id}`, { role: 'Owner admin' }, it)).statusCode).toBe(403);
    expect((await post(`/v1/staff/${me.id}/reset-password`, {}, it)).statusCode).toBe(403);
  });

  it('resets a password: old one stops working, sessions end, a new one is forced', async () => {
    const it = await tokenFor('brian@t.co');
    const before = await signIn('samuel@t.co');
    const sam = (await get('/v1/staff?q=samuel', it)).json().items[0] as { id: string };
    const r = await post(`/v1/staff/${sam.id}/reset-password`, {}, it);
    expect(r.statusCode).toBe(200);
    expect((await get('/v1/me', before.body.accessToken)).statusCode).toBe(401);
    expect((await signIn('samuel@t.co')).res.statusCode).toBe(401);
    const again = await signIn('samuel@t.co', r.json().temporaryPassword);
    expect(again.body.mustChangePassword).toBe(true);
    await post('/v1/auth/change-password', { currentPassword: r.json().temporaryPassword, newPassword: PW }, again.body.accessToken);
  });

  it('suspends and reactivates, cutting access immediately', async () => {
    const it = await tokenFor('brian@t.co');
    const t = await tokenFor('kevin@t.co');
    const kev = (await get('/v1/staff?q=kevin', it)).json().items[0] as { id: string; version: number };
    expect((await patch(`/v1/staff/${kev.id}`, { status: 'suspended', version: kev.version + 5 }, it)).statusCode).toBe(409);
    expect((await patch(`/v1/staff/${kev.id}`, { status: 'suspended' }, it)).json().status).toBe('suspended');
    expect((await get('/v1/me', t)).statusCode).toBe(401);
    const blocked = await signIn('kevin@t.co');
    expect(blocked.res.statusCode).toBe(403);
    expect((await patch(`/v1/staff/${kev.id}`, { status: 'active' }, it)).json().status).toBe('active');
    expect((await signIn('kevin@t.co')).res.statusCode).toBe(200);
  });

  it('never leaves the business without an active owner', async () => {
    const owner = await tokenFor('amara@t.co');
    const [a, b] = ((await get('/v1/staff?role=Owner%20admin', owner)).json().items as { id: string; email: string }[]).sort((x, y) => x.email.localeCompare(y.email));
    const t2 = await tokenFor('owner2@t.co');
    expect((await patch(`/v1/staff/${b!.id}`, { status: 'suspended' }, owner)).statusCode).toBe(200);
    expect((await patch(`/v1/staff/${a!.id}`, { status: 'suspended' }, t2)).statusCode).toBe(401); // owner2 was just signed out
    const t2b = await signIn('owner2@t.co');
    expect(t2b.res.statusCode).toBe(403);
    // only one active owner remains: they can't demote themselves, and nobody could suspend them
    expect((await patch(`/v1/staff/${b!.id}`, { status: 'active' }, owner)).statusCode).toBe(200);
  });
});

describe('roles and permissions', () => {
  it('lets IT view but not hand out powers they do not hold', async () => {
    const it = await tokenFor('brian@t.co');
    const roles = (await get('/v1/roles', it)).json().items as { name: string; system: boolean; permissions: Record<string, boolean[]> }[];
    expect(roles.map((r) => r.name)).toContain('Marketing manager');
    expect(roles.find((r) => r.name === 'Owner admin')!.permissions.Payments).toEqual([true, true, true, true, true]);
    const escalate = await patch('/v1/roles/Marketing%20manager', { permissions: { Marketing: [true, true, true, true, true], Payments: [true, false, false, false, false] } }, it);
    expect(escalate.statusCode).toBe(403);
    const ownRole = await patch('/v1/roles/IT%20support', { permissions: { Staff: [true, true, true, false, true] } }, it);
    expect(ownRole.statusCode).toBe(403);
    const nope = await del('/v1/roles/Marketing%20manager', it);
    expect(nope.statusCode).toBe(403);
  });

  it('lets the owner change permissions and the change applies at once', async () => {
    const owner = await tokenFor('amara@t.co');
    const ruth = await tokenFor('ruth@t.co');
    expect((await get('/v1/audit', ruth)).statusCode).toBe(403);
    const r = await patch('/v1/roles/Marketing%20manager', { permissions: { Marketing: [true, true, true, true, true], Access: [true, false, false, false, false] } }, owner);
    expect(r.statusCode).toBe(200);
    expect((await get('/v1/audit', ruth)).statusCode).toBe(200);
    await patch('/v1/roles/Marketing%20manager', { permissions: { Marketing: [true, true, true, true, true] } }, owner);
    expect((await get('/v1/audit', ruth)).statusCode).toBe(403);
  });

  it('protects the owner role and roles that are still in use', async () => {
    const owner = await tokenFor('amara@t.co');
    expect((await patch('/v1/roles/Owner%20admin', { blurb: 'x' }, owner)).statusCode).toBe(403);
    expect((await del('/v1/roles/Owner%20admin', owner)).statusCode).toBe(403);
    expect((await del('/v1/roles/Customer%20support', owner)).json().error.code).toBe('ROLE_IN_USE');
    const made = await post('/v1/roles', { name: 'Seasonal helper', blurb: 'Temporary', permissions: { Orders: [true, false, false, false, false] } }, owner);
    expect(made.statusCode).toBe(201);
    expect((await del('/v1/roles/Seasonal%20helper', owner)).statusCode).toBe(204);
    expect((await post('/v1/roles', { name: 'Bad', permissions: { Nonsense: [true, false, false, false, false] } }, owner)).statusCode).toBe(400);
  });
});

describe('permissions on the catalogue', () => {
  const product = (sku: string) => ({ sku, name: 'Thing', priceCents: 1000, currency: 'KES', initialStock: 3 });
  it('lets only roles with Products > Create add a product', async () => {
    const ruth = await tokenFor('ruth@t.co');
    const kevin = await tokenFor('kevin@t.co');
    expect((await post('/v1/products', product('PERM-1'), ruth)).statusCode).toBe(403);
    const made = await post('/v1/products', product('PERM-2'), kevin);
    expect(made.statusCode).toBe(201);
    const id = made.json().id as string;
    expect((await post(`/v1/products/${id}/stock-adjustments`, { delta: 2, reason: 'recount' }, ruth)).statusCode).toBe(403);
    expect((await post(`/v1/products/${id}/stock-adjustments`, { delta: 2, reason: 'recount' }, kevin)).statusCode).toBe(200);
  });
});

describe('audit trail', () => {
  it('records who did what, readable only with access', async () => {
    const it = await tokenFor('brian@t.co');
    const log = (await get('/v1/audit?module=Staff&limit=100', it)).json() as { items: { actor: string; action: string }[] };
    expect(log.items.some((e) => e.actor === 'Brian IT' && e.action.startsWith('Created staff account'))).toBe(true);
    expect(log.items.some((e) => e.action === 'Chose a new password')).toBe(true);
    const grace = await tokenFor('grace@t.co');
    expect((await get('/v1/audit', grace)).statusCode).toBe(403);
    expect((await get('/v1/audit')).statusCode).toBe(401);
  });

  it('pages through the trail', async () => {
    const it = await tokenFor('brian@t.co');
    const p1 = (await get('/v1/audit?limit=3', it)).json() as { items: { id: string }[]; nextCursor: string };
    expect(p1.items).toHaveLength(3);
    const p2 = (await get(`/v1/audit?limit=3&cursor=${p1.nextCursor}`, it)).json() as { items: { id: string }[] };
    expect(Number(p2.items[0]!.id)).toBeLessThan(Number(p1.items[2]!.id));
  });
});

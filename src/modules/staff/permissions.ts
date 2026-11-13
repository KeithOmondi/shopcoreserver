/**
 * The permission model. A page or endpoint belongs to exactly one module, and a role is
 * a set of (module, action) pairs. This is the server-side source of truth; the admin
 * app only uses it to decide what to show.
 */
export const MODULES = [
  'Overview', 'Orders', 'Dispatch', 'Products', 'Customers', 'Riders', 'Payments', 'Payroll', 'Reports',
  'Support', 'Claims', 'Marketing', 'Inventory', 'Purchasing', 'Staff', 'Access', 'System', 'Settings',
] as const;
export const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Export'] as const;
export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];

export const OWNER_ROLE = 'Owner admin';
export const IT_ROLE = 'IT support';
/** Only these roles may create staff accounts, reset passwords or suspend people. */
export const ACCOUNT_MANAGERS: readonly string[] = [OWNER_ROLE, IT_ROLE];

export type Matrix = Record<Module, [boolean, boolean, boolean, boolean, boolean]>;
type Row = Matrix[Module];
const row = (view: boolean, create = false, edit = false, del = false, exp = false): Row => [view, create, edit, del, exp];
const perms = (spec: Partial<Record<Module, Row>>): Matrix =>
  Object.fromEntries(MODULES.map((m) => [m, spec[m] ?? row(false)])) as Matrix;

export interface RoleSeed { name: string; blurb: string; system?: boolean; matrix: Matrix }

export const DEFAULT_ROLES: RoleSeed[] = [
  { name: OWNER_ROLE, blurb: 'Full access to all modules', system: true, matrix: Object.fromEntries(MODULES.map((m) => [m, row(true, true, true, true, true)])) as Matrix },
  {
    name: 'Operations manager', blurb: 'Orders, products, riders and delivery',
    matrix: perms({
      Overview: row(true), Orders: row(true, true, true, false, true), Dispatch: row(true, true, true, false, true), Products: row(true, true, true), Customers: row(true, false, true),
      Riders: row(true, true, true), Reports: row(true, false, false, false, true), Support: row(true), Claims: row(true), Marketing: row(true),
      Inventory: row(true, true, true, false, true), Purchasing: row(true, true, true), Staff: row(true), Settings: row(true),
    }),
  },
  { name: 'Dispatch manager', blurb: 'Dispatch, riders, zones and incidents', matrix: perms({ Orders: row(true, true, true, false, true), Dispatch: row(true, true, true, false, true), Riders: row(true, true, true, false, true), Reports: row(true, false, false, false, true) }) },
  {
    name: 'Finance analyst', blurb: 'Payments, payroll, reports and exports',
    matrix: perms({
      Orders: row(true, false, false, false, true), Products: row(true), Payments: row(true, true, true, false, true), Payroll: row(true, true, true, false, true),
      Reports: row(true, false, false, false, true), Claims: row(true, false, true), Purchasing: row(true), Settings: row(true),
    }),
  },
  { name: 'Customer support', blurb: 'Customers, orders and reviews', matrix: perms({ Orders: row(true, false, false, false, true), Dispatch: row(true), Products: row(true), Customers: row(true, true, true), Support: row(true, true, true, false, true), Claims: row(true, true, true, false, true) }) },
  { name: 'Rider manager', blurb: 'Riders, delivery zones and reports', matrix: perms({ Riders: row(true, true, true, false, true), Reports: row(true, false, false, false, true) }) },
  { name: IT_ROLE, blurb: 'Staff accounts, passwords, access and system health', matrix: perms({ Staff: row(true, true, true, false, true), Access: row(true, false, true), System: row(true, true, true, false, true) }) },
  { name: 'Marketing manager', blurb: 'Campaigns, coupons, content and customer engagement', matrix: perms({ Products: row(true), Customers: row(true, false, false, false, true), Reports: row(true, false, false, false, true), Marketing: row(true, true, true, true, true) }) },
  { name: 'Inventory manager', blurb: 'Stock, catalogue and purchasing', matrix: perms({ Orders: row(true, false, true), Products: row(true, true, true, true, true), Reports: row(true, false, false, false, true), Inventory: row(true, true, true, true, true), Purchasing: row(true, true, true, true, true) }) },
  { name: 'Warehouse lead', blurb: 'Receiving, packing and stock counts', matrix: perms({ Orders: row(true, false, true), Products: row(true), Inventory: row(true, true, true, false, true), Purchasing: row(true) }) },
  { name: 'Purchasing agent', blurb: 'Suppliers and purchase orders', matrix: perms({ Products: row(true), Reports: row(true), Inventory: row(true), Purchasing: row(true, true, true, false, true) }) },
];

export const isModule = (v: string): v is Module => (MODULES as readonly string[]).includes(v);
export const isAction = (v: string): v is Action => (ACTIONS as readonly string[]).includes(v);

export function matrixToPairs(m: Partial<Record<string, boolean[]>>): { module: Module; action: Action }[] {
  const out: { module: Module; action: Action }[] = [];
  for (const mod of MODULES) {
    const r = m[mod];
    if (!r) continue;
    ACTIONS.forEach((a, i) => { if (r[i]) out.push({ module: mod, action: a }); });
  }
  return out;
}

export function pairsToMatrix(pairs: { module: string; action: string }[], all = false): Matrix {
  if (all) return perms(Object.fromEntries(MODULES.map((m) => [m, row(true, true, true, true, true)])));
  const m = perms({});
  for (const p of pairs) {
    if (!isModule(p.module) || !isAction(p.action)) continue;
    m[p.module][ACTIONS.indexOf(p.action)] = true;
  }
  return m;
}

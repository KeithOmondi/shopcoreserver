import type { FastifyInstance } from 'fastify';

import type { Action, Module } from '../modules/staff/permissions.js';
import type { StaffContext } from '../modules/staff/staff.js';
import {
  AdminCreateProductSchema, AdminProductListSchema, AdminUpdateProductSchema, BrandPatchSchema, BrandSchema, CategoryPatchSchema, CategorySchema,
  LocationPatchSchema, LocationSchema, SupplierPatchSchema, SupplierSchema, type CatalogService,
} from '../modules/catalog/catalog.js';
import { AdjustSchema, AlertRulesSchema, LevelsQuerySchema, MovementsQuerySchema, TransferSchema, type InventoryService } from '../modules/inventory/inventory.js';
import type { Actor } from '../modules/products/products.js';
import { PoActionSchema, PoListSchema, ReceiveSchema, SavePoSchema, toPoActor, type PoActor, type PurchasingService } from '../modules/inventory/purchasing.js';
import { CountListSchema, CreateReturnSchema, DecideReturnSchema, EnterCountSchema, PickSchema, ReturnListSchema, StartCountSchema, type WarehouseService } from '../modules/inventory/warehouse.js';
import { requireRole } from './auth.js';
import { CustomerListSchema, CustomerPatchSchema, NoteSchema, OrderListSchema, ProfileSchema, type AdminOrdersService, type CustomersService } from '../modules/orders/admin-orders.js';
import type { Authz } from './staff-routes.js';
import { makeGuard } from './guard.js';
import { IdParam, parse } from './validate.js';

export interface AdminServices { catalog: CatalogService; inventory: InventoryService; purchasing: PurchasingService; warehouse: WarehouseService; adminOrders: AdminOrdersService; customers: CustomersService }

/** Catalogue, locations and stock for the admin app. Each route needs one module permission. */
export function registerAdminRoutes(app: FastifyInstance, svc: AdminServices, authz: Authz) {
  const { catalog, inventory, purchasing, warehouse, adminOrders, customers } = svc;
  const { guard, ifMatch, NoStore } = makeGuard(authz);
  const po = (a: Actor, ctx: StaffContext | null): PoActor => toPoActor(a, ctx?.role);

  // ---- locations ------------------------------------------------------------------------
  app.get('/v1/admin/locations', (req) => guard(req, [['Inventory', 'View'], ['Purchasing', 'View']], async () => ({ items: await catalog.locations() })));
  app.post('/v1/admin/locations', (req, reply) => guard(req, [['Inventory', 'Create']], async (a) => reply.status(201).send(await catalog.createLocation(parse(LocationSchema, req.body), a))));
  app.patch('/v1/admin/locations/:id', (req) => guard(req, [['Inventory', 'Edit']], (a) => catalog.updateLocation(parse(IdParam, req.params).id, parse(LocationPatchSchema, req.body), a)));

  // ---- categories & brands -------------------------------------------------------------------
  app.get('/v1/admin/categories', (req) => guard(req, [['Products', 'View']], async () => ({ items: await catalog.categories() })));
  app.post('/v1/admin/categories', (req, reply) => guard(req, [['Products', 'Create']], async (a) => reply.status(201).send(await catalog.createCategory(parse(CategorySchema, req.body), a))));
  app.patch('/v1/admin/categories/:id', (req) => guard(req, [['Products', 'Edit']], (a) => catalog.updateCategory(parse(IdParam, req.params).id, parse(CategoryPatchSchema, req.body), a)));
  app.delete('/v1/admin/categories/:id', (req, reply) => guard(req, [['Products', 'Delete']], async (a) => { await catalog.deleteCategory(parse(IdParam, req.params).id, a); return reply.status(204).send(); }));

  app.get('/v1/admin/brands', (req) => guard(req, [['Products', 'View']], async () => ({ items: await catalog.brands() })));
  app.post('/v1/admin/brands', (req, reply) => guard(req, [['Products', 'Create']], async (a) => reply.status(201).send(await catalog.createBrand(parse(BrandSchema, req.body), a))));
  app.patch('/v1/admin/brands/:id', (req) => guard(req, [['Products', 'Edit']], (a) => catalog.updateBrand(parse(IdParam, req.params).id, parse(BrandPatchSchema, req.body), a)));
  app.delete('/v1/admin/brands/:id', (req, reply) => guard(req, [['Products', 'Delete']], async (a) => { await catalog.deleteBrand(parse(IdParam, req.params).id, a); return reply.status(204).send(); }));

  // ---- suppliers ---------------------------------------------------------------------------------
  app.get('/v1/admin/suppliers', (req) => guard(req, [['Purchasing', 'View'], ['Products', 'View']], async () => ({ items: await catalog.suppliers() })));
  app.post('/v1/admin/suppliers', (req, reply) => guard(req, [['Purchasing', 'Create']], async (a) => reply.status(201).send(await catalog.createSupplier(parse(SupplierSchema, req.body), a))));
  app.patch('/v1/admin/suppliers/:id', (req) => guard(req, [['Purchasing', 'Edit']], (a) => catalog.updateSupplier(parse(IdParam, req.params).id, parse(SupplierPatchSchema, req.body), a)));

  // ---- products ------------------------------------------------------------------------------------
  app.get('/v1/admin/products', (req, reply) => guard(req, [['Products', 'View']], async () => { NoStore(reply); return catalog.listProducts(parse(AdminProductListSchema, req.query)); }));
  app.get('/v1/admin/products/:id', (req, reply) => guard(req, [['Products', 'View']], async () => {
    NoStore(reply);
    const p = await catalog.getProduct(parse(IdParam, req.params).id);
    reply.header('etag', `"${p.version}"`);
    return p;
  }));
  app.post('/v1/admin/products', (req, reply) => guard(req, [['Products', 'Create']], async (a) => {
    const p = await catalog.createProduct(parse(AdminCreateProductSchema, req.body), a);
    return reply.status(201).header('location', `/v1/admin/products/${p.id}`).send(p);
  }));
  app.patch('/v1/admin/products/:id', (req) => guard(req, [['Products', 'Edit']], (a) => catalog.updateProduct(parse(IdParam, req.params).id, ifMatch(req), parse(AdminUpdateProductSchema, req.body), a)));

  // ---- stock ---------------------------------------------------------------------------------------------
  const inv = (needs: Action) => [['Inventory', needs]] as [Module, Action][];
  app.get('/v1/admin/stock/overview', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return inventory.overview(); }));
  app.get('/v1/admin/stock/levels', (req, reply) => guard(req, [['Inventory', 'View'], ['Purchasing', 'View']], async () => { NoStore(reply); return inventory.levels(parse(LevelsQuerySchema, req.query)); }));
  app.get('/v1/admin/stock/movements', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return inventory.movements(parse(MovementsQuerySchema, req.query)); }));
  app.post('/v1/admin/stock/adjust', (req) => guard(req, inv('Edit'), (a) => inventory.adjust(parse(AdjustSchema, req.body), a)));
  app.post('/v1/admin/stock/transfer', (req) => guard(req, inv('Edit'), (a) => inventory.transfer(parse(TransferSchema, req.body), a)));
  app.get('/v1/admin/stock/alerts', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return inventory.alerts(); }));
  // ---- purchasing --------------------------------------------------------------------------------------
  app.get('/v1/admin/purchase-orders', (req, reply) => guard(req, [['Purchasing', 'View']], async () => { NoStore(reply); return purchasing.list(parse(PoListSchema, req.query)); }));
  app.get('/v1/admin/purchase-orders/stats', (req) => guard(req, [['Purchasing', 'View']], async () => ({ items: await purchasing.supplierStats() })));
  app.get('/v1/admin/purchase-orders/:id', (req, reply) => guard(req, [['Purchasing', 'View']], async () => { NoStore(reply); return purchasing.get(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/purchase-orders', (req, reply) => guard(req, [['Purchasing', 'Create']], async (a, ctx) => reply.status(201).send(await purchasing.save(null, parse(SavePoSchema, req.body), po(a, ctx)))));
  app.put('/v1/admin/purchase-orders/:id', (req) => guard(req, [['Purchasing', 'Edit']], (a, ctx) => purchasing.save(parse(IdParam, req.params).id, parse(SavePoSchema, req.body), po(a, ctx), req.headers['if-match'] ? ifMatch(req) : undefined)));
  app.post('/v1/admin/purchase-orders/:id/actions', (req) => guard(req, [['Purchasing', 'Edit']], (a, ctx) => purchasing.act(parse(IdParam, req.params).id, parse(PoActionSchema, req.body).action, po(a, ctx))));
  app.post('/v1/admin/purchase-orders/:id/receive', (req) => guard(req, [['Inventory', 'Edit'], ['Purchasing', 'Edit']], (a, ctx) => purchasing.receive(parse(IdParam, req.params).id, parse(ReceiveSchema, req.body), po(a, ctx))));

  // ---- stock counts ----------------------------------------------------------------------------------------
  app.get('/v1/admin/stock-counts', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return warehouse.counts(parse(CountListSchema, req.query)); }));
  app.get('/v1/admin/stock-counts/:id', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return warehouse.count(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/stock-counts', (req, reply) => guard(req, inv('Create'), async (a, ctx) => reply.status(201).send(await warehouse.startCount(parse(StartCountSchema, req.body), po(a, ctx)))));
  app.post('/v1/admin/stock-counts/:id/entries', (req) => guard(req, inv('Edit'), (a, ctx) => warehouse.enterCount(parse(IdParam, req.params).id, parse(EnterCountSchema, req.body), po(a, ctx))));
  app.post('/v1/admin/stock-counts/:id/submit', (req) => guard(req, inv('Edit'), (a, ctx) => warehouse.submitCount(parse(IdParam, req.params).id, po(a, ctx))));
  app.post('/v1/admin/stock-counts/:id/approve', (req) => guard(req, inv('Edit'), (a, ctx) => warehouse.approveCount(parse(IdParam, req.params).id, po(a, ctx))));

  // ---- returns & packing ---------------------------------------------------------------------------------------
  app.get('/v1/admin/warehouse-returns', (req, reply) => guard(req, inv('View'), async () => { NoStore(reply); return warehouse.returns(parse(ReturnListSchema, req.query)); }));
  app.post('/v1/admin/warehouse-returns', (req, reply) => guard(req, inv('Create'), async (a, ctx) => reply.status(201).send(await warehouse.createReturn(parse(CreateReturnSchema, req.body), po(a, ctx)))));
  app.post('/v1/admin/warehouse-returns/:id/decision', (req) => guard(req, inv('Edit'), (a, ctx) => warehouse.decideReturn(parse(IdParam, req.params).id, parse(DecideReturnSchema, req.body), po(a, ctx))));
  app.get('/v1/admin/packing', (req, reply) => guard(req, [['Orders', 'View'], ['Inventory', 'View']], async () => { NoStore(reply); return warehouse.packingQueue(); }));
  app.post('/v1/admin/packing/:id/pick', (req, reply) => guard(req, [['Orders', 'Edit']], async () => { await warehouse.pick(parse(IdParam, req.params).id, parse(PickSchema, req.body)); return reply.status(204).send(); }));
  app.post('/v1/admin/packing/:id/pack', (req, reply) => guard(req, [['Orders', 'Edit']], async (a, ctx) => { await warehouse.pack(parse(IdParam, req.params).id, po(a, ctx)); return reply.status(204).send(); }));

  // ---- orders (staff view) ---------------------------------------------------------------------------------
  app.get('/v1/admin/orders', (req, reply) => guard(req, [['Orders', 'View']], async () => { NoStore(reply); return adminOrders.list(parse(OrderListSchema, req.query)); }));
  app.get('/v1/admin/orders/stats', (req, reply) => guard(req, [['Orders', 'View']], async () => { NoStore(reply); return adminOrders.stats(); }));
  app.get('/v1/admin/orders/:id', (req, reply) => guard(req, [['Orders', 'View']], async () => { NoStore(reply); return adminOrders.get(parse(IdParam, req.params).id); }));
  app.post('/v1/admin/orders/:id/notes', (req) => guard(req, [['Orders', 'Edit']], (a) => adminOrders.addNote(parse(IdParam, req.params).id, parse(NoteSchema, req.body).text, a)));

  // ---- customers ------------------------------------------------------------------------------------------------
  app.get('/v1/admin/customers', (req, reply) => guard(req, [['Customers', 'View']], async () => { NoStore(reply); return customers.list(parse(CustomerListSchema, req.query)); }));
  app.get('/v1/admin/customers/:id', (req, reply) => guard(req, [['Customers', 'View']], async () => { NoStore(reply); return customers.get(parse(IdParam, req.params).id); }));
  app.patch('/v1/admin/customers/:id', (req) => guard(req, [['Customers', 'Edit']], (a) => customers.update(parse(IdParam, req.params).id, parse(CustomerPatchSchema, req.body), a)));
  app.post('/v1/admin/customers/:id/notes', (req) => guard(req, [['Customers', 'Edit']], (a) => customers.addNote(parse(IdParam, req.params).id, parse(NoteSchema, req.body).text, a)));

  // ---- a shopper's own profile --------------------------------------------------------------------------------
  app.get('/v1/customers/me', async (req, reply) => { NoStore(reply); return customers.mine(requireRole(req, 'customer').sub); });
  app.put('/v1/customers/me', async (req) => customers.updateMine(requireRole(req, 'customer').sub, parse(ProfileSchema, req.body)));

  app.put('/v1/admin/stock/alert-rules', (req) => guard(req, inv('Edit'), (a) => inventory.saveAlertRules(parse(AlertRulesSchema, req.body), a)));

}

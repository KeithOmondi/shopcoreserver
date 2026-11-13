# API Reference (v1)

Base URL: `https://api.shop.example.com`. JSON only. All responses carry `x-request-id`.
Authentication is `Authorization: Bearer <JWT>` issued by the identity provider. Roles come from
the `roles` claim: `customer` (default), `admin`, `payments`.

## Conventions

| Topic | Rule |
|---|---|
| IDs | UUIDv7 strings |
| Money | integer minor units (`priceCents`, `totalCents`) + ISO-4217 `currency` |
| Pagination | `?limit=1..100&cursor=<opaque>`; response `{ items, nextCursor }` (keyset, stable under inserts) |
| Idempotency | `POST /v1/orders` requires `Idempotency-Key` (8–128 chars `[A-Za-z0-9_-]`), scoped per user, retained 48 h |
| Concurrency | `PATCH /v1/products/:id` requires `If-Match: "<version>"` |
| Rate limits | per principal (user, else IP): reads 100 burst / 50 per s, writes 10 burst / 2 per s. Headers `ratelimit-limit`, `ratelimit-remaining`; `429` + `Retry-After` |
| Overload | `503` + `Retry-After` (safe to retry with backoff) |

### Error format
```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock", "details": {} }, "requestId": "01a1..." }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, malformed JSON |
| 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN` |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND` (other users' orders also return 404) |
| 409 | `INSUFFICIENT_STOCK`, `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION`, `SKU_EXISTS` |
| 413 | body > 64 KB |
| 422 | `IDEMPOTENCY_KEY_REUSED`, `PRODUCT_UNAVAILABLE`, `MIXED_CURRENCY`, `NEGATIVE_STOCK` |
| 429 | `RATE_LIMITED` |
| 503 | `SERVICE_UNAVAILABLE` (overload or dependency outage) |

## Endpoints

### Catalog
| Method & path | Auth | Description |
|---|---|---|
| `GET /v1/products?limit&cursor` | optional | Active products (cached ≤ 30 s). |
| `GET /v1/products/:id` | optional | Product; `ETag: "<version>"`; `If-None-Match` → `304`. |
| `GET /v1/products/:id/availability` | optional | `{ productId, available }`, uncached (replica). |
| `POST /v1/products` | admin | `{ sku, name, description?, priceCents, currency, initialStock? }` → 201. Audited. |
| `PATCH /v1/products/:id` | admin | `If-Match` required. `{ name?, description?, priceCents?, active? }`. Audited. |
| `POST /v1/products/:id/stock-adjustments` | admin | `{ delta, reason }`; refuses negative stock. Audited. |

### Orders
| Method & path | Auth | Description |
|---|---|---|
| `POST /v1/orders` | customer | `Idempotency-Key` header; `{ items: [{ productId, quantity }] }` (≤ 50 lines, ≤ 100 qty/line, unique products). 201 created; 200 + `idempotent-replayed: true` on replay. |
| `GET /v1/orders?limit&cursor` | any user | Caller's orders, newest first (summaries). |
| `GET /v1/orders/:id` | owner or admin | Full order with items. |
| `POST /v1/orders/:id/cancel` | owner or admin | `{ reason? }`; from `PENDING_PAYMENT` (releases the reservation) or `PAID` (returns stock, emits `OrderCancelled` with `refundRequired: true` and the `paymentRef`). Not allowed once `FULFILLED`. |
| `POST /v1/orders/:id/payment-confirmation` | payments | `{ paymentRef, amountCents, currency }`. Amount and currency must equal the order total (`422 PAYMENT_AMOUNT_MISMATCH`). Idempotent per `paymentRef`; a different ref on a paid order is `409 ORDER_ALREADY_PAID`; a ref used on another order is `409 PAYMENT_REF_REUSED`. If the order is already cancelled/expired: `409 ORDER_CANCELLED` and an `OrderPaymentOrphaned` event is emitted (once per ref) so the payment service can refund. |
| `POST /v1/orders/:id/fulfillment` | admin | `PAID → FULFILLED` (shipment). |

Order states: `PENDING_PAYMENT → PAID → FULFILLED`; `PENDING_PAYMENT → CANCELLED`; `PAID → CANCELLED` (before shipment).
Unpaid orders auto-cancel after `ORDER_PAYMENT_TIMEOUT_MIN` (default 30) in the worker, one transaction per order.

A machine-readable description is in [openapi.yaml](openapi.yaml).

### Example
```bash
curl -X POST https://api.shop.example.com/v1/orders \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: 7f9c2b1e-checkout-1" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"productId":"01a1cdbf-3b3e-7508-a74a-d7e636a4e0e1","quantity":2}]}'
```

### Operational endpoints (not routed by the ingress)
`GET /health/live`, `GET /health/ready` (fails during shutdown), `GET /health/deps` (dependency
status; requires header `x-health-token` = `HEALTH_DEPS_TOKEN`, and is disabled in production when unset), and `GET :9464/metrics` (Prometheus).

## Domain events (Kafka, topic `shopcore.<aggregate>.v1`, key = aggregate id)
`ProductCreated`, `ProductUpdated`, `StockAdjusted`, `OrderCreated`, `OrderPaid`, `OrderCancelled`
(`{ orderId, reason, refundRequired, paymentRef }`), `OrderFulfilled`, `OrderPaymentOrphaned`
(`{ orderId, paymentRef, amountCents, currency }`: money was taken for a cancelled order; refund it).
Envelope: `{ id, type, occurredAt, data }`; header `event-id` for deduplication.

## Staff sign-in and access (admin app)

Staff accounts live in this API. `POST /v1/auth/login` returns a short-lived access token (15 min, `roles: ["staff"]`,
`sid` = session id) and a rotating refresh token (12 h session). Permissions are **not** in the token: they are read from the
database per request (cached ≤ 10 s), so suspending someone or changing a role takes effect almost at once.

| Method & path | Who | Description |
|---|---|---|
| `POST /v1/auth/login` | public | `{ email, password }` → `{ accessToken, refreshToken, expiresIn, mustChangePassword, staff }`. Same `401` for wrong password and unknown email. 5 failures lock the account for 15 min (`429 ACCOUNT_LOCKED`). Suspended: `403`. |
| `POST /v1/auth/refresh` | public | `{ refreshToken }` → new pair. Tokens rotate; replaying an old one ends that whole sign-in. |
| `POST /v1/auth/logout` | staff | Ends this session (`204`). |
| `POST /v1/auth/change-password` | staff | `{ currentPassword, newPassword }`. Allowed while on a temporary password; every other endpoint answers `403 PASSWORD_CHANGE_REQUIRED` until this is done. Ends other sessions. |
| `GET/PATCH /v1/me` | staff | Own profile + permission matrix; edit own name/phone. |
| `GET /v1/staff`, `GET /v1/staff/:id` | Staff › View | `?q&role&status`. Never returns password data. |
| `POST /v1/staff` | Owner admin, IT support | `{ name, email, phone?, role }` → `201 { staff, temporaryPassword }` (shown once). |
| `PATCH /v1/staff/:id` | Owner admin, IT support | `{ name?, phone?, role?, status?: active\|suspended, version? }`. Not on yourself (role/status); only an owner may touch owners; the last active owner cannot be removed. |
| `POST /v1/staff/:id/reset-password` | Owner admin, IT support | → `{ temporaryPassword }`; ends all their sessions, forces a new password. |
| `POST /v1/staff/:id/sign-out` | Owner admin, IT support | Ends all of a person's sessions (`204`). |
| `GET /v1/roles` | Access/Staff › View | Roles with their permission matrix and head-count. |
| `POST /v1/roles`, `PATCH /v1/roles/:name` | Access › Edit | Non-owners can't grant a permission they don't hold, or change their own role. Owner role is immutable. |
| `DELETE /v1/roles/:name` | Owner admin | Refused while staff still have the role (`409 ROLE_IN_USE`). |
| `GET /v1/audit` | Access › View | `?module&q&limit&cursor`, newest first. |

Catalogue admin routes now check permissions: create/edit products need Products › Create/Edit, stock adjustments need
Inventory › Edit, fulfilment needs Orders › Edit. Service tokens with the `admin` role still work.

First run: `npm run staff -- bootstrap "Owner Name" owner@example.com` prints a one-time password. For development only,
`npm run staff -- demo` creates the 18-person demo team (password `ShopCore#2025`).

## Admin: catalogue, stock, purchasing, orders (permission-checked)

All under `/v1/admin`, staff tokens only; each route needs one module permission (shown). `If-Match: "<version>"` is required to edit a product.

| Area | Endpoints | Needs |
|---|---|---|
| Locations | `GET/POST /locations`, `PATCH /locations/:id` (`{primary:true}` makes it the default; a location holding stock can't be switched off) | Inventory (Purchasing for read) |
| Categories, brands | `GET/POST /categories`, `PATCH/DELETE /categories/:id`, same for `/brands` (a category in use can't be deleted) | Products |
| Suppliers | `GET/POST /suppliers`, `PATCH /suppliers/:id` | Purchasing (Products for read) |
| Products | `GET /products?q&categoryId&status&stock=in\|low\|out`, `GET/PATCH /products/:id`, `POST /products` (with `initialStock`, `locationId`) | Products |
| Stock | `GET /stock/overview \| levels \| movements \| alerts`, `POST /stock/adjust`, `POST /stock/transfer`, `PUT /stock/alert-rules` | Inventory |
| Purchase orders | `GET/POST /purchase-orders`, `PUT /:id` (drafts), `POST /:id/actions {approve\|send\|cancel}`, `POST /:id/receive`, `GET /purchase-orders/stats` | Purchasing (receive: Inventory or Purchasing Edit) |
| Stock counts | `GET/POST /stock-counts`, `POST /:id/entries`, `/submit`, `/approve` | Inventory |
| Returns, packing | `GET/POST /warehouse-returns`, `POST /:id/decision`; `GET /packing`, `POST /packing/:orderId/pick \| pack` | Inventory / Orders Edit |
| Orders | `GET /orders?q&status&payment&method&from&to&customerId`, `GET /orders/:id` (timeline + notes), `POST /orders/:id/notes`, `GET /orders/stats` | Orders |
| Customers | `GET /customers?q&segment`, `GET/PATCH /customers/:id`, `POST /customers/:id/notes` | Customers |

Staff cancel or ship an order with the existing `POST /v1/orders/:id/cancel` / `/fulfillment` (Orders › Edit).
Shoppers: `GET/PUT /v1/customers/me`; `POST /v1/orders` now also accepts `paymentMethod` and `delivery {name, phone, area, address}`.

**Stock model.** Per-location `stock_levels` always sum to `inventory.available + inventory.reserved`; every change goes through one
engine and is recorded in the append-only `stock_movements` log with a running balance. Paying an order takes its units off the
shelf (primary location first), cancelling a paid order returns them. **Maker-checker:** the person who raised a purchase order
over the limit (default KES 100,000, setting `purchasing.approval_limit_cents`) or ran a stock count can't approve it; the owner can.

## Riders, dispatch and delivery money

**Zones and fees.** `GET/POST /v1/admin/zones`, `PATCH/DELETE /zones/:id`, `PUT /v1/admin/delivery-settings` (base fee, minimum basket; Settings › Edit).
An order that carries `delivery.area` gets that zone's fee (or the base fee) added to its total, and is refused below the minimum basket.
The rider earns the fee minus the zone's commission %. **Cash on delivery** (`paymentMethod: "cod"`) is confirmed at once: stock leaves the shelf,
`cod_due_cents` is set, and nothing counts as paid until the rider collects the cash.

**Rider app** (`/v1/rider/...`, rider tokens): `auth/code → auth/verify → auth/register` (SMS code; `RIDER_DEV_OTP` fixes it in development), `auth/login|refresh|logout|reset`,
`GET me`, `PUT me/documents/:key`, `PUT availability`, `POST location`, `GET offers`, `POST offers/:id/accept|decline`, `GET active`,
`POST deliveries/:id/stage {at_pickup|picked_up|at_dropoff}`, `POST deliveries/:id/deliver {code, cashCents?, photoRef?}`, `POST deliveries/:id/fail {reason}`,
`GET history`, `GET earnings`, `POST withdrawals {amountCents}`, `POST incidents {type, sos?}`. Pending, rejected and paused riders can sign in to see their status but cannot work.
Shoppers follow a delivery with `GET /v1/orders/:id/delivery`; the 4-digit handover code appears only once the parcel is on the road.

**Staff** (`/v1/admin/...`): riders (Riders), `riders/:id/actions {approve|reject|suspend|reinstate}`, `riders/:id/documents/:key`, `shifts`;
dispatch (Dispatch): `dispatch/board`, `dispatch/orders/:id/suggestions|history|assign|unassign` (an assignment is an offer the rider has 75 s to accept; `force:true` assigns outright),
`exceptions` (+ `/resolve`), `incidents`; money (Payments): `payouts` (+ `/paid`, `/failed`), `cash` (+ `/:riderId/deposit`), `riders/:id/adjustments`, `riders/:id/ledger`.
Rider earnings and cash are append-only ledgers; a withdrawal sets the money aside immediately and a failed payout puts it back.

## Support: tickets, chat, claims, reviews, help centre

**Staff** (`/v1/admin/...`). *Support module:* `support/overview`, `support/agents`, `tickets` (`?q&status&priority&kind&assignee=me|none|<id>&sla=breached|risk`),
`tickets/:id` (+ `/reply {text, internal}`, `/assign`, `/status`), `chats` (+ `/:id/messages|take|close`), `reviews` (+ `/:id/reply|state`),
`articles`, `help/missed-searches`, `canned-replies` (+ `/:id/use`). *Claims module:* `refunds` (+ `/:id/decision|notes`), `returns` (+ `/:id/decision`), `disputes` (+ `/:id/escalate|resolve`).
A ticket's SLA is a first-reply time by priority (urgent 15 min, high 1 h, normal 4 h, low 24 h); `breached` and `atRisk` are worked out on read.

**Refund rules.** The order must be paid (cash orders: once the rider has collected); the amount can't exceed what is still refundable; one undecided request per order.
Above KES 5,000 (`support.refund_limit_cents`) the decider also needs Payments › Edit. Approval adds to `orders.refunded_cents` and emits a `RefundApproved` event
for the payment service to send the money back. **Returns:** approving one puts the item in the warehouse queue (`/v1/admin/warehouse-returns`) exactly once.
Resolving a dispute for the customer can open a refund for what is still owed.

**Shoppers:** `POST/GET /v1/support/tickets` (+ `/:id`, `/:id/messages`, `/:id/rating`), `GET /v1/support/chat`, `POST /v1/support/chat/messages`,
`POST /v1/orders/:id/returns | refund-requests | review` (delivered orders; returns within 14 days), `GET /v1/support/claims`, and the public `GET /v1/help/articles?q=` / `/:id`
(searches that find nothing are remembered). **Riders:** `POST/GET /v1/rider/support/tickets` (+ `/:id`, `/:id/messages`).

## Finance and payroll

Money is integer cents (KES). Staff routes (`/v1/admin/...`); *Payments module* unless noted. IT and support have no access to either module.
All list and report calls are `no-store`. Business time is Nairobi (UTC+3); a "month" is `YYYY-MM`.

**Overview and reports:** `finance/overview` (month totals, 30-day chart, what needs attention), `finance/settings` (GET/PATCH: cost-of-goods %, store commission %, processing fee %, COD hand-in hours, expense limit, VAT rate),
`accounts` (money held / owed, worked out from the source records, with recent journal entries), `reports/profit-and-loss?month`, `reports/sales?from&to`, `reports/delivery-cost?month`,
`vat` (+ `POST vat/:month/prepare`, `POST vat/:month/file {ack}`).

**Payments:** `payments` (`?status&method&q&failuresOnly`; successful payments come from paid orders, failed attempts from `failed_payments`), `payments/:id` (+ timeline), `payments/:id/retry`, `payments/retry-eligible`.
The payment service reports a failed attempt with `POST /v1/orders/:id/payment-failure {method, reason, ref}` (service token, `payments` role; the same `ref` twice changes nothing).
A retry that clears pays the order; after three attempts a payment goes to *manual review*. The gateway is pluggable (`PaymentGateway`); a development stand-in is used until the M-Pesa/card connection.
**Reconciliation:** `POST reconciliation {file, text}` (CSV with a reference and an amount column) matches lines to paid orders; `GET reconciliation[/:id]`; `POST reconciliation/:id/lines/:lineId/resolve {how, note, orderId?}`; `POST reconciliation/:id/complete`.

**Cash and payouts:** `cash` and `cash/:riderId/deposit {amountCents, ref, method?, account?, note?}` (receipt numbers are unique; each rider shows `overdue` past the hand-in window).
`payout-batches` (GET, POST `{payoutIds, note}`, GET/PATCH/DELETE `/:id`, `POST /:id/send`): **maker-checker**: the preparer can't send their own batch (owners may). Sending is repeatable; each payout records `paid` or `failed`
(a failed one returns the money to the rider). `settlements` (what is owed to each collection point after commission; `POST settlements/:id/pay {ref}`).

**Expenses and invoices:** `expenses` (POST; an owner's own entry is approved at once), `expenses/:id/decision {to, note}`: nobody approves their own, and above the expense limit only an owner approves.
`invoices` (POST `{customer, lines[], dueInDays, draft}`; status is worked out: Draft / Sent / Partly paid / Paid / Overdue), `/:id/send`, `/:id/payments {amountCents, method, ref}`, `/:id/remind`, `DELETE /:id` (drafts only).

**Closing a month:** `periods`, `periods/:month` (checklist: reconcile, COD, payouts, expenses, VAT filed, payroll paid), `POST periods/:month/close {note}` (only when every control is done and the month is over),
`DELETE periods/:month` (owner only, reopens). A closed month rejects expenses, deposits, invoices, batches, settlements and payroll dated in it.
**Exports:** `POST exports {dataset, format: "CSV", month?}` returns the CSV and logs who took it (`GET exports`). Excel files arrive with the wire-up phase. Payroll data needs the *Payroll* module.

**Payroll (*Payroll module*):** `payroll/profiles` (+ `PATCH /:staffId`; amounts never go to the audit log), `payroll/statutory` (GET/PUT; the rates in force are copied into each run),
`payroll/runs` (POST `{month}` works out every active person's slip), `runs/:id`, `runs/:id/adjust/:staffId {bonusCents, otherDeductionCents, note}` (drafts only),
`runs/:id/action {submit|return|approve|pay}`, `runs/:id/payslips/:staffId`, `runs/:id/remittances {kind, ref}`.
Only an owner approves payroll, and never the person who prepared the run (no owner exception here). The statutory figures (NSSF, SHIF, housing levy, PAYE bands, relief) are defaults to **confirm with your accountant**.

## Marketing

Staff routes (`/v1/admin/...`, *Marketing module*; the marketing manager and the owner have it, support and finance don't).

**Audiences:** `segments` (+ `POST segments/preview {match, rules}` to see how many people rules reach before saving; fields `area | spend | orders | lastOrder`). The built-in *All customers* can't change.
Counts are split by what people agreed to: customers choose push/email/SMS with `PUT /v1/me/marketing {push, email, sms}` and everything defaults to **no**. A segment a campaign or coupon uses can't be deleted.

**Coupons** (`coupons`, `coupons/state {ids, state}`): percentage (1-100, optional cap), fixed amount, or free delivery; minimum spend, total and per-customer limits, dates, categories, audience (all / new customers / a segment).
Shoppers send `couponCode` when creating an order (and can preview with `POST /v1/coupons/quote {items, area, couponCode}`). **The discount is always worked out on the server** from live prices; a refused code comes back as
`422 COUPON_INVALID` with a sentence a shopper can read. The coupon row is locked while an order takes it, so a limit can't be beaten by two orders at once, and a cancelled order gives its use back.
A used coupon's code and type are frozen. `orders.discount_cents` is the total taken off (order total = goods + delivery − discount).

**Flash sales and bundles:** a live sale changes the price shoppers pay (the order line records the sale price); products at or below the sale's stock guard are left out, and a product can sit in only one live sale at once.
Bundles (fixed price for a set), cross-sells and multi-buys (% off when you take N) give the best single saving for a basket. By default coupons don't stack on sale items (`marketing/rules.noStackFlash`) and a coupon with `combine: false` is refused when a bundle applies.

**Homepage:** `banners` (+ `/:id/move`, `banner-settings`): publishing needs alt text and a link that goes somewhere (fixed storefront routes, a category, or a published page).
`homepage` sections are a draft; `POST homepage/publish {mode: now|later, at}` copies them to what shoppers see (`GET /v1/storefront/home?platform=web|mobile`, no login). A scheduled layout goes live from the worker.

**Push, email, SMS:** `pushes`, `messages` (`action`: `draft | schedule | now`). Sends are held out of quiet hours (21:00 to 07:00 Nairobi) when the campaign says so, one capped push a day per overlapping audience (`409 FREQUENCY_CAP`),
and due ones are sent by the worker (`marketing-due`, every 30 s). Reach counts only opted-in customers. Opens, deliveries and clicks come back from the provider at `POST /v1/internal/marketing/:kind/:id/results` (service token with the `notifications` role).
Until the real providers are connected a development sender only records the send.

**Campaigns** (`campaigns`, `campaigns/:id/channels`): a coupon-linked campaign's conversions and sales come from real redemptions; other channels are entered or reported by the provider. **Loyalty and referral** settings, **review highlights**
(good, visible reviews chosen for the storefront), **pages** (`pages`, published pages appear at `GET /v1/storefront/page?slug=`), and **category copy** (`category-content`, `GET /v1/storefront/categories/:handle`).

## Web admin sign-in, M-Pesa, text messages, files

**Web admin refresh cookie.** Send `X-Client: web` on `/v1/auth/login`, `/refresh` and `/logout`: the refresh token then travels only in an httpOnly, `SameSite=Strict` cookie
(`sc_refresh`, path `/v1/auth`, `Secure` in production) and is left out of the response body; `/refresh` reads the cookie. Without the header nothing changes, so the phone apps keep using the body token.
Serve the admin and the API from one address (the dev server proxies `/v1`); if they must differ, set `CORS_ORIGINS` and `VITE_API_URL`.

**M-Pesa** (`MPESA_ENV`: `off | simulator | sandbox | production`). Customer: `POST /v1/orders/:id/pay/mpesa {phone}` sends the STK prompt (order total must be whole shillings),
`GET` the same path to poll `{status: pending|success|failed|cancelled, message, receipt}`. Safaricom posts the result to `POST /v1/webhooks/mpesa/:secret` (the secret is `MPESA_CALLBACK_SECRET`, compared in constant time).
A good result marks the order paid with the M-Pesa receipt as its payment reference, once; an amount that doesn't match leaves the order unpaid and writes an `mpesa.mismatch` audit entry;
a failed or cancelled prompt lands in the failed-payments list. In `simulator` mode no network call is made: `POST` the callback yourself (see `test/integration/integrations.test.ts`).
With real M-Pesa on, "retry" in the failed-payments list asks the customer to pay again from the app (it never charges anyone itself).

**Text messages** (`SMS_PROVIDER=africastalking`, `AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID`): rider sign-in codes and other texts go out through Africa's Talking; `console` only logs.

**Files.** `PUT /v1/uploads?kind=<rider-document|banner|return-photo|delivery-photo|avatar|product-image>&name=` with the picture (JPEG, PNG or WebP; PDF for rider documents) as the request body and its `Content-Type`.
The bytes are checked, not just the label; the limit is `UPLOAD_MAX_BYTES`. Returns `{id, url}`; `GET /v1/files/:id` serves it: banners and product pictures to anyone, everything else to the uploader and to staff.
Who may upload what is fixed per kind (customers: returns, avatar; riders: documents, delivery photos; staff: banners and product pictures with the matching permission).
In production, payouts to riders refuse to send until a real sender is connected (`PAYOUTS_NOT_CONNECTED`): pay from the M-Pesa portal and mark each payout paid.

## Shopper accounts (customer app)

Sign-up is two steps so a number is confirmed before an account exists: `POST /v1/customer/auth/signup {fullName, email, phone, password}` (202, code sent by SMS; `409 EMAIL_EXISTS` / `PHONE_EXISTS` carry `details.field`),
then `POST /v1/customer/auth/verify-signup {phone, code}` (201, returns tokens and the user). `POST .../resend {phone}`. Sign in with `POST .../login {identifier, password}` (email or phone; five wrong passwords lock it for ten minutes),
`POST .../refresh {refreshToken}` (rotating; a reused token ends the whole session family), `POST .../logout`.
Forgotten password: `POST .../forgot {identifier}` (always 202, so it can't reveal who has an account) → `POST .../verify-reset {identifier, code}` → `{resetToken}` → `POST .../reset {resetToken, password}` (ends every session).
Account: `GET/PATCH /v1/customer/me`, `POST /v1/customer/me/password`, `POST /v1/customer/me/delete {password}` (refused while paid orders are on their way; wipes name, contact and consent, keeps orders). Access tokens last 15 minutes (`CUSTOMER_ACCESS_TTL_S`) and
are checked against the live session on these routes, so signing out or deleting takes effect at once. In development set `CUSTOMER_DEV_OTP` to fix the code (the app's demo code is 123456).

**Shop catalogue (public).** `GET /v1/storefront/catalogue` returns the categories (with sub-categories), brands and every buyable product in one call: picture links (`/v1/files/:id`), the price right now
(a live flash sale included, with `listPriceCents` beside it), `inStock`, `isNew`, and a rating that is the average of shoppers' reviews of orders containing the product. Attach pictures with `PUT /v1/admin/products/:id/images {uploadIds}` (uploaded as kind `product-image`).

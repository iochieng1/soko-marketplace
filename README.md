# Soko

[![CI](https://github.com/iochieng1/soko-marketplace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iochieng1/soko-marketplace/actions/workflows/ci.yml)

**A headless e-commerce marketplace for Kenyan sellers, with M-Pesa checkout, that can't oversell stock.**

> 🚧 Work in progress. Done so far: monorepo scaffold, database schema, health checks, CI, seller auth, product CRUD, catalogue and product pages, seller dashboard, cart, checkout with stock reservations, reservation expiry.
>
> <!-- TODO: demo GIF here once checkout works -->
>
> **Live storefront:** _coming soon_ · **Live API:** _coming soon_

Soko ("market" in Swahili) lets small Kenyan sellers list products and get paid by M-Pesa. The API is headless: the Next.js storefront in this repo is one client, and any other frontend can use the same API.

Payments go through [PayBridge](https://github.com/iochieng1/paybridge), a separate M-Pesa gateway API I am building alongside this one. Soko asks PayBridge to start an STK push, then receives HMAC-SHA256 signed webhooks when the payment succeeds or fails.

The hard part of a marketplace isn't listing products. It's making sure that when the last item gets two checkouts in the same second, and one M-Pesa prompt is ignored, exactly one customer gets it and the stock count is still right afterwards.

## Features (roadmap)

- [x] npm workspaces monorepo: Fastify API, Next.js storefront, shared zod contract
- [x] PostgreSQL schema and migrations for sellers, products, inventory, stock reservations, orders, webhook dedupe and an outbox
- [x] Database CHECK constraints that make an oversold inventory row impossible to store, with tests
- [x] `/health` endpoint that checks Postgres and Redis
- [x] `GET /v1/products`: active products, keyset-paginated, plus a seed script
- [x] Storefront product listing with empty and error states
- [x] CI: lint, format, typecheck, migration drift check, integration tests on real Postgres/Redis, builds, secret scanning
- [x] Seller auth: argon2id passwords, 15-minute access JWTs, rotating refresh tokens with reuse detection
- [x] Product CRUD for sellers, unique slugs, stock edits guarded by the DB constraint
- [x] Catalogue search, product detail pages and a seller dashboard
- [x] Cart in local storage, priced by `POST /v1/cart/quote`
- [x] Idempotent checkout that reserves stock with conditional `UPDATE`s, proven by a 50-way concurrency test
- [x] Reservation expiry sweeper (BullMQ, every minute) that never releases stock twice, and explicit handling of payments that arrive after expiry
- [x] M-Pesa payment via PayBridge, with a "check your phone" screen that polls until the payment settles
- [ ] Signed webhook verification (`X-PayBridge-Signature`) and deduplication
- [ ] Transactional outbox for confirmation emails/SMS
- [ ] Concurrency load test proving no oversell

## Quick start

Requires Node 24 (`nvm use`) and Docker.

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/storefront/.env.example apps/storefront/.env.local
docker compose up -d     # Postgres :5433 + Redis :6380 (PayBridge keeps 5432/6379)
npm run db:migrate
npm run db:seed          # a demo seller and a few sample products
npm run dev:api          # http://localhost:4000/health, /v1/products
npm run dev:storefront   # http://localhost:3001 (in another terminal)
```

The seed creates a demo seller for the dashboard at http://localhost:3001/seller/products: `duka@example.co.ke` / `soko-demo-1234`.

## API

All bodies are JSON. Errors use one envelope: `{ "error": { "code", "message", "details?" } }`.

| Endpoint                        | Auth   | What it does                                                               |
| ------------------------------- | ------ | -------------------------------------------------------------------------- |
| `GET /health`                   |        | Checks Postgres and Redis                                                  |
| `GET /v1/products?q=&cursor=`   |        | Active products, newest first, keyset-paginated, title search              |
| `GET /v1/products/:slug`        |        | One active product with `available` stock; drafts and archived are `404`   |
| `POST /v1/auth/register`        |        | Create a seller; `409 EMAIL_TAKEN` for a duplicate email in any case       |
| `POST /v1/auth/login`           |        | Returns `access_token` (15 min) and `refresh_token`                        |
| `POST /v1/auth/refresh`         |        | Swaps a refresh token for a new pair; a replayed token revokes the session |
| `POST /v1/auth/logout`          |        | Revokes the session the refresh token belongs to                           |
| `GET /v1/auth/me`               | Bearer | The logged-in seller                                                       |
| `GET /v1/seller/products`       | Bearer | The seller's own products in every status, with stock                      |
| `POST /v1/seller/products`      | Bearer | Create a product (`DRAFT` or `ACTIVE`) with its starting stock             |
| `GET /v1/seller/products/:id`   | Bearer | One of the seller's products; anyone else's is `404`                       |
| `PATCH /v1/seller/products/:id` | Bearer | Edit title, description, price, status (`ARCHIVED` to archive), `on_hand`  |
| `POST /v1/cart/quote`           |        | Current prices, stock and total for a cart; flags problems per line        |
| `POST /v1/checkout`             |        | Place an order, reserve its stock and send the M-Pesa prompt               |
| `GET /v1/orders/:id/status`     |        | The order's status for the payment screen; no customer details             |

Lowering `on_hand` below the stock reserved by unpaid orders returns `409 STOCK_BELOW_RESERVED`.

**Cart quote.** Send `{ "items": [{ "product_id", "quantity", "expected_price?" }] }`. Each line comes back with the server's `unit_price`, `available` stock and `issues`: `UNAVAILABLE` (missing, draft or archived), `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, or `PRICE_CHANGED` (differs from `expected_price`). `can_checkout` is false if any line is unavailable or short, or the total is over M-Pesa's KES 250,000 limit. A price change alone doesn't block checkout.

**Checkout.** Send `customer_email`, `customer_phone` (the M-Pesa number) and the same `items`, with a unique `Idempotency-Key` header (a UUID). It returns `201` with a `PENDING_PAYMENT` order whose stock is held until `reserved_until` (10 minutes). Retrying with the same key returns the same order with `200`; reusing the key for a different cart or customer is `422 IDEMPOTENCY_KEY_REUSED`. Failures roll back everything: `409 OUT_OF_STOCK`, `409 PRICE_CHANGED` (a stale `expected_price`), `409 PRODUCT_UNAVAILABLE`, `422 ORDER_TOTAL_TOO_LARGE`.

**Payment.** Once the order and its stock are committed, checkout calls PayBridge `POST /v1/payments` with the order id as the `Idempotency-Key` and stores the returned `paybridge_payment_id`. If M-Pesa rejects the push (PayBridge `502`) or PayBridge refuses the request (`400`/`422`), the reservation is released at once and the order comes back as `PAYMENT_FAILED`. If PayBridge can't be reached, the order stays `PENDING_PAYMENT` and the request is retried by a checkout retry or the next status poll; PayBridge never sends a second prompt for the same key. `GET /v1/orders/:id/status` also looks up the payment in PayBridge (at most once per order every `PAYBRIDGE_SYNC_INTERVAL_SECONDS`): `SUCCEEDED` marks the order `PAID` and consumes the stock, while `FAILED`, `CANCELLED` and `TIMED_OUT` release the reservation and mark it `PAYMENT_FAILED`. A success whose amount differs from the order total is logged and not applied.

**Expiry.** Every minute a BullMQ job releases the stock of orders still unpaid at `reserved_until` and marks them `EXPIRED`. If payment for an expired order arrives later, the stock is taken again if it's still there and the order becomes `PAID`; if not, the order becomes `REFUND_PENDING`.

## Scripts

Run from the repository root.

| Command                                   | What it does                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev:api`                         | Start the API with hot reload                                      |
| `npm run dev:storefront`                  | Start the storefront (Next.js dev server)                          |
| `npm test`                                | All tests. API tests start throwaway Postgres/Redis containers     |
| `npm run lint` / `npm run typecheck`      | Static checks across every workspace                               |
| `npm run format` / `npm run format:check` | Prettier                                                           |
| `npm run build`                           | Build shared, API and storefront                                   |
| `npm run db:generate`                     | Generate a SQL migration after editing `apps/api/src/db/schema.ts` |
| `npm run db:migrate`                      | Apply migrations to `DATABASE_URL`                                 |
| `npm run db:seed`                         | Insert sample products (safe to re-run)                            |

In production, the API's `npm start` applies migrations and then boots.

## Project structure

```
apps/
  api/                  # Fastify headless commerce API
    src/
      app.ts            # Fastify app factory (used by server and tests)
      server.ts         # Entry point: listen + graceful shutdown
      config.ts         # zod-validated environment variables
      db/
        schema.ts       # Drizzle schema (source of truth, with design notes)
        client.ts       # Postgres connection
        migrate.ts      # Migration runner
        seed.ts         # Sample data
      auth/             # Password hashing, JWT plugin, refresh-token rotation
      jobs/             # BullMQ jobs (reservation expiry sweeper)
      lib/              # Order loading, reservation sweeping, payment settlement
      routes/           # HTTP routes
    drizzle/            # Generated SQL migrations (committed)
    test/               # Vitest + Testcontainers integration tests
    Dockerfile          # Build from the repo root
  storefront/           # Next.js (App Router) + Tailwind storefront
    app/                # Pages: catalogue, product detail, cart, seller login/register/dashboard
    lib/api.ts          # Typed API client (validates responses with shared schemas)
    lib/cart.ts         # The cart, in local storage
    lib/session*.ts     # httpOnly session cookies
    proxy.ts            # Refreshes the seller's access token before /seller pages render
packages/
  shared/               # zod schemas + TS types for the API contract
```

## Trade-offs

Decisions and the reasons for them. This section grows as features land.

- **Reserve stock at checkout, not decrement at payment.** M-Pesa payment is asynchronous: the customer gets an STK prompt on their phone and may take 30+ seconds to enter a PIN, or ignore it. If stock were only decremented when payment succeeds, two customers could both pay for the last item and one would need a refund. Reserving at checkout means a customer is only asked to pay for stock that is held for them. The cost is that abandoned checkouts hold stock, which is why reservations expire and a sweeper releases them.
- **Conditional `UPDATE` over `SELECT … FOR UPDATE` for reserving.** Checkout runs `UPDATE inventory SET reserved = reserved + $q WHERE product_id = $id AND on_hand - reserved >= $q` for each line, which checks and reserves in one atomic statement; zero rows updated means out of stock and the whole order rolls back. With `SELECT … FOR UPDATE` you lock the row, read the stock, decide in application code, then write: one more round trip per line, the lock held across all of it, and correctness depends on every caller remembering to take the lock first. Forget it once and two plain reads can both see the last unit. The conditional `UPDATE` can't be used wrongly that way. When two checkouts hit the same row, Postgres makes the second wait, then re-checks its `WHERE` against the committed row (READ COMMITTED re-evaluation), so the last unit is reserved exactly once. A multi-item checkout still takes several row locks, so lines are reserved in product-id order: two carts with the same products can't each hold a row the other needs, so there's no deadlock. `test/checkout.test.ts` fires 50 parallel checkouts at 10 units and expects exactly 10 orders and 40 `409`s, plus a mixed-order cart test for deadlocks. `SELECT … FOR UPDATE` is the better tool when the decision needs more than one row's state, which reserving doesn't.
- **The expiry sweeper locks orders with `SKIP LOCKED` and releases only `ACTIVE` rows.** Each batch picks expired reservations through the partial index on `expires_at WHERE status = 'ACTIVE'`, locks their orders with `FOR UPDATE SKIP LOCKED`, flips `ACTIVE` reservations to `RELEASED` and gives back exactly the quantities its `RETURNING` reported, all in one transaction. Two sweepers split the work instead of fighting over it. A second run finds no `ACTIVE` rows, so stock is never released twice. A payment locks the same order row, so a payment and an expiry run one after the other, never interleaved. BullMQ's scheduler means only one instance sweeps per tick, but correctness doesn't depend on that: the tests run 8 sweepers at once, and race payments against the sweeper.
- **A late payment re-reserves the stock if it can, otherwise it's flagged for a refund.** An M-Pesa callback can land after the order expired. Refusing the money outright would be worse than selling the stock if it's still there, so the payment takes the stock again with the same conditional `UPDATE` checkout uses, all lines or none (a savepoint). If any line has been bought by someone else, the order becomes `REFUND_PENDING`. It never takes stock that another customer is holding. Refunds are issued by hand for now.
- **Idempotency key on the order row, checked against the request.** The order is inserted before any stock is touched, so a retry racing its original blocks on the `idempotency_key` unique index and, once the original commits, rolls back and returns that order. A replay only succeeds if the email, phone and items match. Otherwise anyone who guessed or saw a key would get someone else's order back, and a client bug that reused a key would silently get the wrong order.
- **A database CHECK constraint as the last line of defence.** `inventory` has `CHECK (reserved >= 0 AND reserved <= on_hand)`. Application logic should never hit it. But if a bug, a missed race or a manual SQL fix tries to oversell, Postgres rejects the write and the transaction rolls back. Correctness doesn't rely on every code path being right, and there's a test that proves it.
- **Transactional outbox over sending emails/SMS inline.** Sending a confirmation inside the payment-webhook handler gives two bad outcomes: a message for a transaction that then rolls back, or a committed order whose message is lost because the process crashed after commit. Writing an `outbox` row in the same transaction as `status = 'PAID'` makes "order paid" and "message queued" atomic. A worker sends it later, with retries. Delivery is at-least-once, so senders must tolerate duplicates.
- **The cart is client-side; prices come from the server.** For v1 the cart lives in the browser's local storage, with no cart table. Shoppers don't need accounts. Browsing and building a cart cost the database nothing until checkout. There's no abandoned-cart data to expire. Since stock is only held at checkout, a server-side cart wouldn't hold anything anyway. The browser's copy is untrusted: `POST /v1/cart/quote` re-prices every line from the database and flags price changes and stock problems, and checkout repeats every check inside its transaction and ignores client prices except to refuse a stale one (`409 PRICE_CHANGED`). The costs: the cart doesn't follow a shopper across devices, and sellers can't see what's sitting in carts. A server-side cart is worth adding along with customer accounts.
- **Prices as integer whole shillings.** M-Pesa only moves whole KES, so there is no floating-point money and no cents column. `order_items.unit_price` snapshots the price at checkout.
- **M-Pesa via PayBridge, not Stripe.** The target market is Kenya, where M-Pesa is how people pay online and card ownership is low. A card-first processor like Stripe would add friction for most buyers, while M-Pesa collection goes through Safaricom's Daraja API. Calling PayBridge keeps Daraja's quirks (STK timeouts, duplicate callbacks, token expiry) out of the marketplace. Soko only has to verify signed webhooks and dedupe them (`processed_webhooks`).
- **PayBridge is called after the checkout transaction commits, not inside it.** An HTTP call inside the transaction would hold inventory row locks for as long as Daraja takes to answer, which serialises every checkout of a popular product behind someone else's network round trip. The cost is a window where the order exists without a payment. That is safe because the call is idempotent on the order id: a checkout retry or a status poll asks again, and if nothing gets through, the sweeper releases the stock when the reservation expires.
- **Status polls fall back to asking PayBridge, throttled per order.** Signed webhooks are the main way payment results arrive, but a lost webhook shouldn't leave a shopper staring at a spinner. So the status endpoint looks the payment up itself, at most once per order every 10 seconds (a Redis `SET NX EX`). PayBridge allows 60 payment calls a minute for the whole API key, and without the throttle a few open tabs would use up everyone's budget.
- **Keyset pagination over `OFFSET`.** The catalogue is ordered by `(created_at, id)` and the cursor encodes the last row. Pages stay fast as the table grows, and nothing gets skipped or repeated when products are added between page loads.
- **Tests run against real Postgres and Redis (Testcontainers), not mocks.** The guarantees here come from constraints, row locks and transactions. Mocks would test none of them.
- **Short access tokens plus rotating refresh tokens, over long-lived JWTs.** A JWT can't be revoked before it expires, so access tokens last 15 minutes. Refresh tokens are random, stored only as SHA-256 hashes, single use, and grouped into a family per login. If a token that was already used shows up again, someone holds a copy, so the whole family is revoked. The cost: two refreshes racing with the same token (two tabs at the exact moment the access token expires) log the seller out. That is safer than the alternative and rare enough to accept for now.
- **argon2id with OWASP's baseline parameters (19 MiB, t=2, p=1).** Memory-hard, so GPU cracking of a leaked table is expensive. The parameters are stored in each hash, so they can be raised later without a migration. Login runs a real verify even for an unknown email, so timing doesn't reveal which emails have accounts.
- **Another seller's product is `404`, not `403`.** Every seller query is scoped by `seller_id` in SQL. A `403` would confirm the id exists, letting anyone probe other sellers' catalogues.
- **Lowering stock is checked by the database, not by reading `reserved` first.** The seller's `PATCH` just writes `on_hand`, and the `reserved <= on_hand` CHECK rejects it if unpaid orders hold more. A read-then-write check could pass and then lose to a checkout reserving stock in between.
- **Slugs are unique, generated once and never changed.** Editing a title keeps the old slug, so links that have been shared keep working. A clash gets a random suffix, and the unique constraint (not a `SELECT` beforehand) decides who gets the clean slug.
- **Tokens in httpOnly cookies, refreshed in `proxy.ts`.** The storefront never exposes tokens to browser JavaScript. Server Components can't set cookies, so the Next.js proxy refreshes an expired access token before a `/seller` page renders.
- **Title search is `ILIKE`, for now.** It's a scan over active products, which is fine at this size. A `pg_trgm` GIN index is the next step if the catalogue grows.
- **Monorepo with a shared zod contract.** The API and storefront import the same schemas, so a breaking change to a response shape fails the typecheck instead of the storefront at runtime.

## Deployment

- **API, Postgres, Redis:** `render.yaml` is a Render Blueprint that creates the API as a Docker web service (`apps/api/Dockerfile`, built from the repo root), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**. Migrations run on start-up.
- **Storefront:** Vercel. Import the repo, set **Root Directory** to `apps/storefront` (Vercel installs from the workspace root), and set `API_BASE_URL` to the Render API URL.

## License

MIT

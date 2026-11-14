# Soko

[![CI](https://github.com/iochieng1/soko-marketplace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iochieng1/soko-marketplace/actions/workflows/ci.yml)

**A headless e-commerce marketplace for Kenyan sellers, with M-Pesa checkout, that can't oversell stock.**

> 🚧 Work in progress. Done so far: monorepo scaffold, database schema, health checks, CI, seller auth, product CRUD, catalogue and product pages, seller dashboard.
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
- [ ] Cart
- [ ] Checkout with stock reservations (`SELECT … FOR UPDATE` / conditional `UPDATE`)
- [ ] Reservation expiry sweeper
- [ ] M-Pesa payment via PayBridge
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

Lowering `on_hand` below the stock reserved by unpaid orders returns `409 STOCK_BELOW_RESERVED`.

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
      routes/           # HTTP routes
    drizzle/            # Generated SQL migrations (committed)
    test/               # Vitest + Testcontainers integration tests
    Dockerfile          # Build from the repo root
  storefront/           # Next.js (App Router) + Tailwind storefront
    app/                # Pages: catalogue, product detail, seller login/register/dashboard
    lib/api.ts          # Typed API client (validates responses with shared schemas)
    lib/session*.ts     # httpOnly session cookies
    proxy.ts            # Refreshes the seller's access token before /seller pages render
packages/
  shared/               # zod schemas + TS types for the API contract
```

## Trade-offs

Decisions and the reasons for them. This section grows as features land.

- **Reserve stock at checkout, not decrement at payment.** M-Pesa payment is asynchronous: the customer gets an STK prompt on their phone and may take 30+ seconds to enter a PIN, or ignore it. If stock were only decremented when payment succeeds, two customers could both pay for the last item and one would need a refund. Reserving at checkout means a customer is only asked to pay for stock that is held for them. The cost is that abandoned checkouts hold stock, which is why reservations expire and a sweeper releases them.
- **Conditional `UPDATE` over `SELECT … FOR UPDATE` for reserving.** `UPDATE inventory SET reserved = reserved + $q WHERE product_id = $id AND reserved + $q <= on_hand` checks and reserves in one atomic statement. Zero rows updated means out of stock. It holds a row lock only for that statement, needs no extra round trip, and has no read-then-write window. `SELECT … FOR UPDATE` is still the right tool when a decision needs several rows read first (for example, locking a multi-item cart's rows in a consistent order to avoid deadlocks), so checkout may use both.
- **A database CHECK constraint as the last line of defence.** `inventory` has `CHECK (reserved >= 0 AND reserved <= on_hand)`. Application logic should never hit it. But if a bug, a missed race or a manual SQL fix tries to oversell, Postgres rejects the write and the transaction rolls back. Correctness doesn't rely on every code path being right, and there's a test that proves it.
- **Transactional outbox over sending emails/SMS inline.** Sending a confirmation inside the payment-webhook handler gives two bad outcomes: a message for a transaction that then rolls back, or a committed order whose message is lost because the process crashed after commit. Writing an `outbox` row in the same transaction as `status = 'PAID'` makes "order paid" and "message queued" atomic. A worker sends it later, with retries. Delivery is at-least-once, so senders must tolerate duplicates.
- **Prices as integer whole shillings.** M-Pesa only moves whole KES, so there is no floating-point money and no cents column. `order_items.unit_price` snapshots the price at checkout.
- **M-Pesa via PayBridge, not Stripe.** The target market is Kenya, where M-Pesa is how people pay online and card ownership is low. A card-first processor like Stripe would add friction for most buyers, while M-Pesa collection goes through Safaricom's Daraja API. Calling PayBridge keeps Daraja's quirks (STK timeouts, duplicate callbacks, token expiry) out of the marketplace. Soko only has to verify signed webhooks and dedupe them (`processed_webhooks`).
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

import Fastify, { type FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

import { jwtPlugin } from "./auth/authenticate.js";
import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import {
  createPayBridgeClient,
  type PayBridgeClient,
} from "./lib/paybridge.js";
import type { PaymentDeps } from "./lib/payment-sync.js";
import authRoutes from "./routes/auth.js";
import cartRoutes from "./routes/cart.js";
import checkoutRoutes from "./routes/checkout.js";
import healthRoutes from "./routes/health.js";
import orderRoutes from "./routes/orders.js";
import productRoutes from "./routes/products.js";
import sellerProductRoutes from "./routes/seller-products.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
    paybridge: PayBridgeClient;
    /** Everything the payment flow needs, logging to `log`. */
    paymentDeps: (log: FastifyBaseLogger) => PaymentDeps;
  }
}

export const buildApp = async (config: Config) => {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
      redact: [
        "req.headers.authorization",
        "req.body.password",
        "req.body.refresh_token",
        "req.headers['x-paybridge-signature']",
      ],
    },
  });

  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("redis", redis);
  app.decorate(
    "paybridge",
    createPayBridgeClient({
      baseUrl: config.PAYBRIDGE_API_URL,
      apiKey: config.PAYBRIDGE_API_KEY,
    }),
  );
  app.decorate("paymentDeps", (log: FastifyBaseLogger) => ({
    db,
    redis,
    paybridge: app.paybridge,
    log,
    syncIntervalSeconds: config.PAYBRIDGE_SYNC_INTERVAL_SECONDS,
  }));

  app.addHook("onClose", async () => {
    await Promise.allSettled([sql.end(), redis.quit()]);
  });

  await app.register(jwtPlugin);
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(productRoutes, { prefix: "/v1" });
  await app.register(sellerProductRoutes, { prefix: "/v1" });
  await app.register(cartRoutes, { prefix: "/v1" });
  await app.register(checkoutRoutes, { prefix: "/v1" });
  await app.register(orderRoutes, { prefix: "/v1" });

  return app;
};

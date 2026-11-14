import Fastify from "fastify";
import { Redis } from "ioredis";

import { jwtPlugin } from "./auth/authenticate.js";
import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import productRoutes from "./routes/products.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
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

  app.addHook("onClose", async () => {
    await Promise.allSettled([sql.end(), redis.quit()]);
  });

  await app.register(jwtPlugin);
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(productRoutes, { prefix: "/v1" });

  return app;
};

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

import { runMigrations } from "../src/db/migrate.js";
import { startFakePayBridge } from "./fake-paybridge.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
    paybridgeUrl: string;
    paybridgeApiKey: string;
  }
}

// Real Postgres and Redis in throwaway containers: tests exercise the same
// constraints, locks and Lua scripts that production does.
export default async function setup(project: TestProject) {
  const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] =
    await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      new RedisContainer("redis:7-alpine").start(),
    ]);

  // Every test app talks to this fake unless it starts its own, so nothing
  // in the suite can reach the real PayBridge.
  const paybridge = await startFakePayBridge();

  const databaseUrl = postgres.getConnectionUri();
  await runMigrations(databaseUrl);

  project.provide("databaseUrl", databaseUrl);
  project.provide("redisUrl", redis.getConnectionUrl());
  project.provide("paybridgeUrl", paybridge.url);
  project.provide("paybridgeApiKey", paybridge.apiKey);

  return async () => {
    await Promise.all([postgres.stop(), redis.stop(), paybridge.close()]);
  };
}

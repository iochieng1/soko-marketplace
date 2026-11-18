import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startOutboxWorker } from "./jobs/outbox-worker.js";
import { startReservationSweeper } from "./jobs/reservation-sweeper.js";
import { createNotifier } from "./lib/notifier.js";

const config = loadConfig();
const app = await buildApp(config);

// Runs in the API process: one service to deploy, and the sweep is safe to
// run from every instance at once.
const sweeper = await startReservationSweeper({
  db: app.db,
  redisUrl: config.REDIS_URL,
  log: app.log,
  everyMs: config.RESERVATION_SWEEP_INTERVAL_SECONDS * 1000,
});

// Sends the confirmation emails and SMS queued when orders are paid.
const outboxWorker = startOutboxWorker(
  {
    db: app.db,
    notifier: createNotifier(config, app.log),
    log: app.log,
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  },
  { everyMs: config.OUTBOX_POLL_INTERVAL_MS },
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  // Stop taking jobs before the database pool closes under them.
  await Promise.all([sweeper.close(), outboxWorker.close()]);
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

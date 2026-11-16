import { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

import type { Database } from "../db/client.js";
import {
  type SweepResult,
  sweepExpiredReservations,
} from "../lib/reservations.js";

export const SWEEPER_QUEUE = "reservation-sweeper";
const SCHEDULER_ID = "expire-reservations";

export interface SweeperOptions {
  db: Database;
  redisUrl: string;
  log: FastifyBaseLogger;
  everyMs: number;
  /** BullMQ key prefix; tests use their own so they can't see each other. */
  prefix?: string;
}

/**
 * Runs `sweepExpiredReservations` on a BullMQ job scheduler.
 *
 * Every API instance calls this at boot. The scheduler is upserted by id, so
 * there is one schedule however many instances run, and BullMQ hands each
 * tick to one worker. That is an efficiency measure only: the sweep itself is
 * safe to run concurrently (see `sweepExpiredReservations`).
 */
export const startReservationSweeper = async ({
  db,
  redisUrl,
  log,
  everyMs,
  prefix,
}: SweeperOptions) => {
  // BullMQ needs maxRetriesPerRequest: null for its blocking commands.
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const queue = new Queue(SWEEPER_QUEUE, {
    connection: queueConnection,
    prefix,
  });
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { every: everyMs },
    {
      name: "sweep",
      opts: { removeOnComplete: 100, removeOnFail: 500 },
    },
  );

  const worker = new Worker<unknown, SweepResult>(
    SWEEPER_QUEUE,
    () => sweepExpiredReservations(db),
    { connection: workerConnection, prefix, concurrency: 1 },
  );
  worker.on("completed", (_job, result) => {
    if (result.releasedReservations > 0) {
      log.info(result, "Released expired stock reservations");
    }
  });
  worker.on("failed", (job, err) => {
    log.error({ err, jobId: job?.id }, "Reservation sweep failed");
  });
  worker.on("error", (err) => {
    log.error({ err }, "Reservation sweeper worker error");
  });

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
      await Promise.allSettled([
        queueConnection.quit(),
        workerConnection.quit(),
      ]);
    },
  };
};

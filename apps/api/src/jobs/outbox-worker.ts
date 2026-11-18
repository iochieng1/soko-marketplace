import { drainOutbox, type OutboxWorkerDeps } from "../lib/outbox.js";

/**
 * Polls the outbox every `everyMs` and sends whatever is due.
 *
 * Every API instance runs one. That's safe because rows are claimed with
 * `FOR UPDATE SKIP LOCKED`: instances share the backlog instead of sending the
 * same message twice. Plain polling (not BullMQ) because the rows are the
 * queue. A second queue would have to be kept in step with them.
 */
export const startOutboxWorker = (
  deps: OutboxWorkerDeps,
  { everyMs }: { everyMs: number },
) => {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      await drainOutbox(deps, { shouldStop: () => stopped });
    } catch (err) {
      // A database blip: log it and try again next tick.
      deps.log.error({ err }, "Outbox worker tick failed");
    }
    if (!stopped) timer = setTimeout(schedule, everyMs);
  };
  const schedule = () => {
    running = tick();
  };

  schedule();

  return {
    /** Stops polling and waits for the message being sent, if any. */
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
};

/**
 * Run as a child process by test/outbox.test.ts. It claims one outbox row,
 * "sends" it (printing the message as JSON), then hangs until the test
 * SIGKILLs it: a worker that dies after the provider accepted the message
 * but before recording it.
 */
import type { FastifyBaseLogger } from "fastify";

import { createDb } from "../../src/db/client.js";
import { processOutboxOnce } from "../../src/lib/outbox.js";

const noop = () => {};
const log = {
  info: noop,
  warn: noop,
  error: noop,
  child: () => log,
} as unknown as FastifyBaseLogger;

const { db } = createDb(process.argv[2]!);
const hang = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  return new Promise<void>(() => {});
};

await processOutboxOnce({
  db,
  log,
  maxAttempts: 5,
  notifier: { email: hang, sms: hang },
});

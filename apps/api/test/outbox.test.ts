import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { asc, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, type Database } from "../src/db/client.js";
import { outbox } from "../src/db/schema.js";
import {
  type EmailMessage,
  NotConfiguredError,
  type Notifier,
  PermanentNotifierError,
  type SmsMessage,
} from "../src/lib/notifier.js";
import {
  drainOutbox,
  ORDER_CONFIRMATION_EMAIL,
  ORDER_CONFIRMATION_SMS,
  type OrderConfirmationPayload,
  type OutboxWorkerDeps,
  processOutboxOnce,
  requeueAbandoned,
} from "../src/lib/outbox.js";
import { paymentReference } from "../src/lib/payment-sync.js";
import { createIsolatedDatabase } from "./helpers.js";

type Sent =
  ({ channel: "email" } & EmailMessage) | ({ channel: "sms" } & SmsMessage);

/** Records what it sends. `before` runs first and can throw or wait. */
const fakeNotifier = (before: (sent: Sent) => unknown = () => {}) => {
  const sent: Sent[] = [];
  const notifier: Notifier = {
    email: async (m) => {
      await before({ channel: "email", ...m });
      sent.push({ channel: "email", ...m });
    },
    sms: async (m) => {
      await before({ channel: "sms", ...m });
      sent.push({ channel: "sms", ...m });
    },
  };
  return { notifier, sent };
};

const recordingLog = () => {
  const entries: { level: string; obj: unknown; msg?: string }[] = [];
  const log: Record<string, unknown> = { level: "info" };
  for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
    log[level] = (obj: unknown, msg?: string) =>
      entries.push({ level, obj, msg });
  }
  log.silent = () => {};
  log.child = () => log;
  return { log: log as unknown as FastifyBaseLogger, entries };
};

/** A gate a test opens when it's ready. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const CRASH_WORKER = fileURLToPath(
  new URL("./fixtures/outbox-crash-worker.ts", import.meta.url),
);

const ORDER_ID = "0b6f3c2e-5d4a-4f1e-9a7b-2c8d9e0f1a2b";

const payload = (
  to: string,
  orderId: string = crypto.randomUUID(),
): OrderConfirmationPayload => ({
  order_id: orderId,
  to,
  total: 4500,
  items: [
    { title: "Kiondo bag", quantity: 2, line_total: 3000 },
    { title: "Kikoi", quantity: 1, line_total: 1500 },
  ],
});

describe("outbox worker", () => {
  let url: string;
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    url = await createIsolatedDatabase();
    const created = createDb(url);
    db = created.db;
    close = () => created.sql.end();
  });

  afterAll(() => close());

  beforeEach(async () => {
    await db.delete(outbox);
  });

  const enqueue = async (
    type = ORDER_CONFIRMATION_EMAIL,
    body: unknown = payload("wanjiru@example.co.ke"),
  ) => {
    const [row] = await db
      .insert(outbox)
      .values({ type, payload: body })
      .returning({ id: outbox.id });
    const orderId = (body as { order_id?: unknown }).order_id;
    if (typeof orderId === "string") orderIds.set(row!.id, orderId);
    return row!.id;
  };

  const orderIds = new Map<number, string>();
  /** The Resend idempotency key the row's email is sent with. */
  const keyOf = (id: number) => `order-confirmation-email-${orderIds.get(id)}`;

  const rowOf = async (id: number) => {
    const [r] = await db.select().from(outbox).where(eq(outbox.id, id));
    return r!;
  };

  const deps = (
    notifier: Notifier,
    overrides: Partial<OutboxWorkerDeps> = {},
  ): OutboxWorkerDeps => ({
    db,
    notifier,
    log: recordingLog().log,
    maxAttempts: 5,
    ...overrides,
  });

  it("sends the confirmation email and SMS and marks each row processed", async () => {
    const emailId = await enqueue(
      ORDER_CONFIRMATION_EMAIL,
      payload("wanjiru@example.co.ke", ORDER_ID),
    );
    const smsId = await enqueue(
      ORDER_CONFIRMATION_SMS,
      payload("254712345678", ORDER_ID),
    );
    const { notifier, sent } = fakeNotifier();

    expect(await drainOutbox(deps(notifier))).toEqual({
      sent: 2,
      retry: 0,
      deferred: 0,
      gave_up: 0,
    });

    const reference = paymentReference(ORDER_ID);
    expect(sent).toEqual([
      {
        channel: "email",
        to: "wanjiru@example.co.ke",
        subject: `Order ${reference} is confirmed`,
        text: expect.stringContaining("Total paid: KES 4,500"),
        idempotencyKey: keyOf(emailId),
      },
      {
        channel: "sms",
        to: "254712345678",
        message: `Soko: payment of KES 4,500 received for order ${reference}. Thank you!`,
      },
    ]);
    expect((sent[0] as EmailMessage).text).toContain(
      "2 x Kiondo bag  KES 3,000",
    );
    for (const id of [emailId, smsId]) {
      const row = await rowOf(id);
      expect(row.processedAt).toBeInstanceOf(Date);
      expect(row.attempts).toBe(1);
    }

    // Sent rows are never picked up again.
    expect(await processOutboxOnce(deps(notifier))).toBe("idle");
    expect(sent).toHaveLength(2);
  });

  describe("a crash between commit and send", () => {
    it("loses nothing: a message queued before the crash is sent by the next worker", async () => {
      // The payment transaction committed its outbox rows, then the process
      // died before any worker ran. They are just rows, so they wait.
      const id = await enqueue();

      const { notifier, sent } = fakeNotifier();
      await drainOutbox(deps(notifier));

      expect(sent).toHaveLength(1);
      expect((await rowOf(id)).processedAt).toBeInstanceOf(Date);
    });

    it("resends a message whose worker was killed mid-send, with the same idempotency key", async () => {
      const id = await enqueue();

      // A real process, killed with SIGKILL after the provider "accepted" the
      // email but before the worker recorded it.
      const child = spawn(
        process.execPath,
        ["--import", "tsx", CRASH_WORKER, url],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const [line] = (await once(
        createInterface({ input: child.stdout! }),
        "line",
      )) as [string];
      const firstSend = JSON.parse(line) as EmailMessage;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;

      // Nothing was recorded, so the message is still queued.
      const row = await rowOf(id);
      expect(row.processedAt).toBeNull();
      expect(row.attempts).toBe(0);

      // Postgres drops the dead session's lock as soon as it notices.
      const { notifier, sent } = fakeNotifier();
      let result = await processOutboxOnce(deps(notifier));
      for (let i = 0; result === "idle" && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        result = await processOutboxOnce(deps(notifier));
      }
      expect(result).toBe("sent");
      // Same key, so Resend drops the repeat instead of emailing twice.
      expect((sent[0] as EmailMessage).idempotencyKey).toBe(
        firstSend.idempotencyKey,
      );
      expect(firstSend.idempotencyKey).toBe(keyOf(id));
    });
  });

  describe("two workers (SKIP LOCKED)", () => {
    it("skips a row another worker is sending and takes the next one", async () => {
      const firstId = await enqueue();
      const secondId = await enqueue();
      const sending = gate();
      const release = gate();
      const a = fakeNotifier(async () => {
        sending.open();
        await release.opened;
      });
      const b = fakeNotifier();

      const workerA = processOutboxOnce(deps(a.notifier));
      await sending.opened;
      expect(await processOutboxOnce(deps(b.notifier))).toBe("sent");
      // A holds the first row, so B didn't wait for it or send it.
      expect(await processOutboxOnce(deps(b.notifier))).toBe("idle");
      release.open();
      expect(await workerA).toBe("sent");

      expect(a.sent.map((m) => (m as EmailMessage).idempotencyKey)).toEqual([
        keyOf(firstId),
      ]);
      expect(b.sent.map((m) => (m as EmailMessage).idempotencyKey)).toEqual([
        keyOf(secondId),
      ]);
    });

    it("never send the same message when draining a backlog together", async () => {
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(await enqueue());
      const slow = () => new Promise((r) => setTimeout(r, 25));
      const a = fakeNotifier(slow);
      const b = fakeNotifier(slow);

      await Promise.all([
        drainOutbox(deps(a.notifier)),
        drainOutbox(deps(b.notifier)),
      ]);

      const keys = [...a.sent, ...b.sent].map(
        (m) => (m as EmailMessage).idempotencyKey,
      );
      expect(keys.sort()).toEqual(ids.map((id) => keyOf(id)).sort());
      expect(new Set(keys).size).toBe(12);
      expect(a.sent.length).toBeGreaterThan(0);
      expect(b.sent.length).toBeGreaterThan(0);
    });
  });

  describe("retries", () => {
    it("backs off after a failure and tries again once it's due", async () => {
      const id = await enqueue();
      let fail = true;
      const { notifier, sent } = fakeNotifier(() => {
        if (fail) throw new Error("Resend refused the email (503: busy)");
      });
      const worker = deps(notifier, { backoffMs: () => 60_000 });

      expect(await processOutboxOnce(worker)).toBe("retry");
      const row = await rowOf(id);
      expect(row.attempts).toBe(1);
      expect(row.lastError).toBe("Resend refused the email (503: busy)");
      expect(row.processedAt).toBeNull();
      const [{ waitSeconds }] = (await db.execute(
        sql`select extract(epoch from next_attempt_at - now())::int as "waitSeconds" from outbox where id = ${id}`,
      )) as unknown as [{ waitSeconds: number }];
      expect(waitSeconds).toBeGreaterThan(55);

      // Not due yet.
      fail = false;
      expect(await processOutboxOnce(worker)).toBe("idle");

      await db
        .update(outbox)
        .set({ nextAttemptAt: sql`now() - interval '1 second'` })
        .where(eq(outbox.id, id));
      expect(await processOutboxOnce(worker)).toBe("sent");
      expect(sent).toHaveLength(1);
      expect((await rowOf(id)).attempts).toBe(2);
      expect((await rowOf(id)).lastError).toBeNull();
    });

    it("gives up after maxAttempts and logs an error to alert on", async () => {
      const id = await enqueue();
      const { notifier } = fakeNotifier(() => {
        throw new Error("gateway down");
      });
      const { log, entries } = recordingLog();

      const counts = await drainOutbox(
        deps(notifier, { log, maxAttempts: 3, backoffMs: () => 0 }),
      );

      expect(counts).toEqual({
        sent: 0,
        retry: 2,
        deferred: 0,
        gave_up: 1,
      });
      const row = await rowOf(id);
      expect(row.attempts).toBe(3);
      expect(row.failedAt).toBeInstanceOf(Date);
      expect(row.processedAt).toBeNull();
      expect(entries.filter((e) => e.level === "error")).toEqual([
        expect.objectContaining({
          msg: "Outbox message abandoned; it needs a person to look at it",
          obj: expect.objectContaining({ outboxId: id, attempts: 3 }),
        }),
      ]);
      // Abandoned rows aren't picked up again.
      expect(await processOutboxOnce(deps(notifier))).toBe("idle");
    });

    it("gives up at once on a message that can never be sent", async () => {
      const unknown = await enqueue("carrier_pigeon");
      const unreadable = await enqueue(ORDER_CONFIRMATION_SMS, { to: 42 });
      const { notifier, sent } = fakeNotifier();

      expect(await drainOutbox(deps(notifier))).toEqual({
        sent: 0,
        retry: 0,
        deferred: 0,
        gave_up: 2,
      });
      expect(sent).toHaveLength(0);
      expect((await rowOf(unknown)).lastError).toMatch(/Unknown outbox/);
      expect((await rowOf(unreadable)).lastError).toMatch(/Unreadable/);
    });

    it("sends in order, and one failing message doesn't hold up the rest", async () => {
      const failing = await enqueue(
        ORDER_CONFIRMATION_SMS,
        payload("254700000000"),
      );
      const fine = await enqueue();
      const { notifier, sent } = fakeNotifier((m) => {
        if (m.channel === "sms") throw new Error("no credit");
      });

      await drainOutbox(deps(notifier));

      expect(sent.map((m) => m.channel)).toEqual(["email"]);
      const rows = await db.select().from(outbox).orderBy(asc(outbox.id));
      expect(rows.map((r) => [r.id, r.attempts, !!r.processedAt])).toEqual([
        [failing, 1, false],
        [fine, 1, true],
      ]);
    });
  });

  describe("review fixes", () => {
    it("keeps messages for an unconfigured channel queued without using attempts", async () => {
      const id = await enqueue();
      const { notifier } = fakeNotifier(() => {
        throw new NotConfiguredError("No email provider is configured");
      });

      for (let i = 0; i < 3; i++) {
        await db
          .update(outbox)
          .set({ nextAttemptAt: sql`now()` })
          .where(eq(outbox.id, id));
        expect(
          await processOutboxOnce(deps(notifier, { maxAttempts: 2 })),
        ).toBe("deferred");
      }

      const row = await rowOf(id);
      expect(row.attempts).toBe(0);
      expect(row.failedAt).toBeNull();
      expect(row.lastError).toBe("No email provider is configured");

      // Once the provider is set up, it goes out.
      await db
        .update(outbox)
        .set({ nextAttemptAt: sql`now()` })
        .where(eq(outbox.id, id));
      const configured = fakeNotifier();
      expect(await processOutboxOnce(deps(configured.notifier))).toBe("sent");
    });

    it("abandons at once a message the provider will never accept", async () => {
      const id = await enqueue();
      const { notifier } = fakeNotifier(() => {
        throw new PermanentNotifierError(
          "Resend refused the email (422: bad to)",
        );
      });

      expect(await processOutboxOnce(deps(notifier))).toBe("gave_up");
      expect((await rowOf(id)).attempts).toBe(1);
      expect((await rowOf(id)).failedAt).toBeInstanceOf(Date);
    });

    it("stops between messages when asked to", async () => {
      for (let i = 0; i < 5; i++) await enqueue();
      let stop = false;
      const { notifier, sent } = fakeNotifier(() => {
        stop = true;
      });

      const counts = await drainOutbox(deps(notifier), {
        shouldStop: () => stop,
      });

      expect(counts.sent).toBe(1);
      expect(sent).toHaveLength(1);
    });

    it("re-queues abandoned messages with a fresh set of attempts", async () => {
      const id = await enqueue();
      const failing = fakeNotifier(() => {
        throw new Error("down");
      });
      await drainOutbox(
        deps(failing.notifier, { maxAttempts: 2, backoffMs: () => 0 }),
      );
      expect((await rowOf(id)).failedAt).toBeInstanceOf(Date);

      expect(await requeueAbandoned(db)).toEqual([id]);
      const row = await rowOf(id);
      expect(row.failedAt).toBeNull();
      expect(row.attempts).toBe(0);

      // One transient failure no longer abandons it straight away.
      const flaky = fakeNotifier(() => {
        throw new Error("503");
      });
      expect(
        await processOutboxOnce(deps(flaky.notifier, { maxAttempts: 2 })),
      ).toBe("retry");
    });
  });
});

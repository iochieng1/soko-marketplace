import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { PayBridgeStatus } from "../src/lib/paybridge.js";

export type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

export type FakePayment = {
  id: string;
  status: PayBridgeStatus;
  amount: number;
  phone: string;
  reference: string;
  description: string;
  result_desc: string | null;
};

export type Reply = { status: number; body?: unknown } | "hang";
/** Overrides `POST /v1/payments`; return undefined to fall through. */
export type CreateHandler = (
  request: RecordedRequest,
) => Reply | undefined | Promise<Reply | undefined>;

/**
 * A stand-in for PayBridge v1 on 127.0.0.1, so tests never touch the
 * network. By default it behaves like the real thing: `POST /v1/payments`
 * answers 202 PENDING and is idempotent on the Idempotency-Key, and
 * `GET /v1/payments/:id` returns what `settle` last set.
 */
export const startFakePayBridge = async ({
  apiKey = "pk_test_fake",
}: { apiKey?: string } = {}) => {
  const requests: RecordedRequest[] = [];
  const payments = new Map<string, FakePayment>();
  const byKey = new Map<string, string>();
  const hanging = new Set<ServerResponse>();
  let onCreate: CreateHandler | undefined;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request: RecordedRequest = {
      method: req.method!,
      path: req.url!,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(request);

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return send(res, 401, {
        statusCode: 401,
        error: "Unauthorized",
        message: "Invalid API key",
      });
    }

    if (request.method === "POST" && request.path === "/v1/payments") {
      const override = await onCreate?.(request);
      if (override === "hang") {
        hanging.add(res);
        return;
      }
      if (override) return send(res, override.status, override.body);

      const key = String(req.headers["idempotency-key"]);
      const existing = byKey.get(key);
      if (existing) return send(res, 202, payments.get(existing));

      const input = request.body as Omit<FakePayment, "id" | "status">;
      const payment: FakePayment = {
        id: randomUUID(),
        status: "PENDING",
        amount: input.amount,
        phone: input.phone,
        reference: input.reference,
        description: input.description,
        result_desc: null,
      };
      payments.set(payment.id, payment);
      byKey.set(key, payment.id);
      return send(res, 202, payment);
    }

    const match = /^\/v1\/payments\/([^/]+)$/.exec(request.path);
    if (request.method === "GET" && match) {
      const payment = payments.get(decodeURIComponent(match[1]!));
      if (!payment) {
        return send(res, 404, {
          statusCode: 404,
          error: "Not Found",
          message: "Payment not found",
        });
      }
      return send(res, 200, payment);
    }

    send(res, 404, {
      statusCode: 404,
      error: "Not Found",
      message: "No route",
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    /** Requests to `POST /v1/payments`. */
    creates: () =>
      requests.filter((r) => r.method === "POST" && r.path === "/v1/payments"),
    /** Requests to `GET /v1/payments/:id`. */
    lookups: () => requests.filter((r) => r.method === "GET"),
    payment: (id: string) => payments.get(id),
    /** Moves a payment to a final status, as a Daraja callback would. */
    settle: (
      id: string,
      status: PayBridgeStatus,
      changes: Partial<FakePayment> = {},
    ) => {
      const payment = payments.get(id);
      if (!payment) throw new Error(`No fake payment ${id}`);
      Object.assign(payment, { status, ...changes });
    },
    onCreate: (handler: CreateHandler | undefined) => {
      onCreate = handler;
    },
    reset: () => {
      requests.length = 0;
      onCreate = undefined;
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

export type FakePayBridge = Awaited<ReturnType<typeof startFakePayBridge>>;

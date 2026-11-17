import type { OrderStatusResponse } from "@soko/shared";
import type { FastifyPluginAsync } from "fastify";

import { isUuid, sendError } from "../lib/errors.js";
import { loadOrder } from "../lib/orders.js";
import { syncPayment } from "../lib/payment-sync.js";

const orderRoutes: FastifyPluginAsync = async (app) => {
  /**
   * What the storefront's "check your phone" screen polls. No auth: the
   * order id (a random UUID) is the capability, so the response holds no
   * customer details.
   */
  app.get<{ Params: { id: string } }>(
    "/orders/:id/status",
    async (request, reply) => {
      const { id } = request.params;
      if (!isUuid(id)) {
        return sendError(reply, 404, "ORDER_NOT_FOUND", "Order not found");
      }

      // Webhook fallback: catch up with PayBridge (throttled per order).
      await syncPayment(app.paymentDeps(request.log), id.toLowerCase());

      const order = await loadOrder(app.db, { id: id.toLowerCase() });
      if (!order) {
        return sendError(reply, 404, "ORDER_NOT_FOUND", "Order not found");
      }
      const body: OrderStatusResponse = {
        id: order.id,
        status: order.status,
        total: order.total,
        currency: order.currency,
        reserved_until: order.reserved_until,
      };
      return reply.header("cache-control", "no-store").send(body);
    },
  );
};

export default orderRoutes;

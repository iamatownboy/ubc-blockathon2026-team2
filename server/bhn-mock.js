// The gift card provider, mocked — shaped like the real API.
//
// A separate HTTP listener (port 8788 in the demo), so the provider client
// really crosses a network boundary. It has the failure modes the demo
// needs and the admin console can arm them live:
//
//   normal   issue the card, return it
//   error    502 — the provider is down
//   timeout  accept the connection and never answer; no card is issued
//   ghost    issue the card, then drop the response on the floor
//   httpghost issue the card, then return 502; lookup must recover it
//
// The order endpoint accepts NO recipient block: cards come back in the
// response (API-return mode) and the programme delivers them itself, so an
// e-mail address is not available as a shortcut even by accident.
"use strict";

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const PRODUCTS = [
  { productCode: "TIMHORTONS-CA-0500", brand: "Tim Hortons", valueCad: 5, currency: "CAD", closedLoop: true },
  { productCode: "SAVEON-CA-1000", brand: "Save-On-Foods", valueCad: 10, currency: "CAD", closedLoop: true },
  { productCode: "TRANSLINK-CA-1000", brand: "TransLink", valueCad: 10, currency: "CAD", closedLoop: true },
  { productCode: "MAPLECAFE-CA-0500", brand: "Maple Café", valueCad: 5, currency: "CAD", closedLoop: true },
  // Closed loop, and still not ours: a provider sells plenty the programme has
  // never reviewed. It syncs as listed:false and cannot be configured.
  { productCode: "PETROCAN-CA-2500", brand: "Petro-Canada", valueCad: 25, currency: "CAD", closedLoop: true },
  // A real provider catalog also carries these. Our catalog must refuse it.
  { productCode: "VISA-CA-2500", brand: "Visa Prepaid", valueCad: 25, currency: "CAD", openLoop: true, network: "VISA" },
];

const MODES = ["normal", "error", "timeout", "ghost", "httpghost"];

function createMockProvider({ cert = "demo-partner-cert" } = {}) {
  const state = {
    mode: "normal",
    once: true,
    orders: new Map(), // requestId -> order
    byRef: new Map(), // orderRef -> order
    cards: new Map(), // cardnbr -> { pin, expiry, productCode, balance, currency }
    pending: new Set(), // hung responses (timeout mode)
    log: [],
    counters: { orders: 0, requests: 0 },
  };

  const log = (event, fields = {}) => {
    const entry = { at: new Date().toISOString(), event, ...fields };
    state.log.push(entry);
    if (state.log.length > 500) state.log.shift();
    return entry;
  };

  const consumeMode = () => {
    const mode = state.mode;
    if (mode !== "normal" && state.once) state.mode = "normal";
    return mode;
  };

  function newCard(product) {
    // A closed-loop number: 16 digits, unique. Never logged anywhere.
    let cardnbr;
    do {
      cardnbr = "6" + crypto.randomInt(0, 1e9).toString().padStart(9, "0") + crypto.randomInt(0, 1e6).toString().padStart(6, "0");
    } while (state.cards.has(cardnbr));
    const pin = crypto.randomInt(0, 10000).toString().padStart(4, "0");
    const expiry = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    state.cards.set(cardnbr, { pin, expiry, productCode: product.productCode, balance: product.valueCad, currency: product.currency });
    return { cardnbr, pin, expiry, valueCad: product.valueCad, currency: product.currency, productCode: product.productCode };
  }

  function createOrder(requestId, product) {
    const orderRef = "ORD-" + String(++state.counters.orders).padStart(6, "0");
    const order = { orderRef, requestId, status: "fulfilled", productCode: product.productCode, createdAt: new Date().toISOString(), card: newCard(product) };
    state.orders.set(requestId, order);
    state.byRef.set(orderRef, order);
    log("order.issued", { requestId, orderRef, productCode: product.productCode });
    return order;
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve(null);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const p = url.pathname;

    // ---- demo controls (the mock's own admin surface) --------------------
    if (p === "/admin/state" && req.method === "GET") {
      return json(res, 200, { mode: state.mode, once: state.once, modes: MODES, orders: state.orders.size, cards: state.cards.size, log: state.log.slice(-50) });
    }
    if (p === "/admin/mode" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !MODES.includes(body.mode)) return json(res, 400, { error: "bad_mode", modes: MODES });
      state.mode = body.mode;
      state.once = body.once !== false;
      if (state.mode !== "timeout") {
        for (const r of state.pending) r.destroy();
        state.pending.clear();
      }
      log("mode.armed", { mode: state.mode, once: state.once });
      return json(res, 200, { mode: state.mode, once: state.once });
    }
    if (p === "/admin/reset" && req.method === "POST") {
      state.orders.clear();
      state.byRef.clear();
      state.cards.clear();
      state.log.length = 0;
      state.mode = "normal";
      return json(res, 200, { ok: true });
    }

    // ---- the provider API ------------------------------------------------
    if (p === "/v1/catalog" && req.method === "GET") {
      return json(res, 200, { products: PRODUCTS });
    }

    // Certificate-style auth stand-in: the partner cert travels as a header.
    if (req.headers["x-partner-cert"] !== cert) {
      return json(res, 401, { error: "unauthorized", message: "partner certificate missing or invalid" });
    }

    if (p === "/v1/orders" && req.method === "POST") {
      state.counters.requests += 1;
      const requestId = req.headers["x-request-id"];
      const body = await readBody(req);
      if (!requestId) return json(res, 400, { error: "missing_request_id", message: "X-Request-Id is required; it is the idempotency key" });
      if (!body) return json(res, 400, { error: "bad_json" });
      if ("recipient" in body || "email" in body || "recipientEmail" in body) {
        return json(res, 400, { error: "recipient_not_supported", message: "This endpoint issues cards in API-return mode only. No recipient block is accepted." });
      }
      if (Number(body.quantity ?? 1) !== 1) return json(res, 400, { error: "quantity_must_be_one" });
      const product = PRODUCTS.find((x) => x.productCode === body.productCode);
      if (!product) return json(res, 404, { error: "unknown_product", productCode: body.productCode });

      // Idempotent: the same request id returns the same order, never a second card.
      const existing = state.orders.get(requestId);
      if (existing) {
        log("order.replayed", { requestId, orderRef: existing.orderRef });
        return json(res, 200, existing);
      }

      const mode = consumeMode();
      if (mode === "error") {
        log("order.failed", { requestId, mode });
        return json(res, 502, { error: "provider_unavailable", message: "upstream issuer unavailable" });
      }
      if (mode === "timeout") {
        log("order.hung", { requestId, mode });
        state.pending.add(res);
        res.on("close", () => state.pending.delete(res));
        return; // never answered; nothing was issued
      }
      const order = createOrder(requestId, product);
      if (mode === "httpghost") {
        log("order.httpghost", { requestId, orderRef: order.orderRef, mode });
        return json(res, 502, { error: "gateway_failed_after_issue", message: "gateway failed after the issuer accepted the order" });
      }
      if (mode === "ghost") {
        log("order.ghosted", { requestId, orderRef: order.orderRef, mode });
        req.socket.destroy(); // the card exists; the caller hears nothing
        return;
      }
      return json(res, 201, order);
    }

    if (p === "/v1/orders" && req.method === "GET") {
      const requestId = url.searchParams.get("requestId");
      const order = requestId ? state.orders.get(requestId) : null;
      log("order.lookup", { requestId, found: Boolean(order) });
      if (!order) return json(res, 404, { error: "order_not_found", requestId });
      return json(res, 200, order);
    }

    const byRef = p.match(/^\/v1\/orders\/(ORD-\d+)$/);
    if (byRef && req.method === "GET") {
      const order = state.byRef.get(byRef[1]);
      if (!order) return json(res, 404, { error: "order_not_found" });
      return json(res, 200, order);
    }

    const balance = p.match(/^\/v1\/cards\/(\d+)\/balance$/);
    if (balance && req.method === "GET") {
      const card = state.cards.get(balance[1]);
      if (!card) return json(res, 404, { error: "card_not_found" });
      return json(res, 200, { productCode: card.productCode, balance: card.balance, currency: card.currency, expiry: card.expiry });
    }

    return json(res, 404, { error: "not_found" });
  });

  return {
    server,
    state,
    PRODUCTS,
    MODES,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: address.port, url: `http://${host}:${address.port}` });
        });
      });
    },
    close() {
      for (const r of state.pending) r.destroy();
      state.pending.clear();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    setMode(mode, once = true) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
      state.mode = mode;
      state.once = once;
      log("mode.armed", { mode, once });
    },
  };
}

module.exports = { createMockProvider, PRODUCTS, MODES };

if (require.main === module) {
  const port = Number(process.env.PROVIDER_PORT ?? 8788);
  createMockProvider({ cert: process.env.PROVIDER_CERT })
    .listen(port)
    .then(({ url }) => console.log(`mock gift card provider listening on ${url}`));
}

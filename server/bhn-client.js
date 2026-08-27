// The gift card provider client.
//
// The provider is mocked; the client is not. It does certificate-style
// auth, idempotency keys, order lookup and timeout recovery against a
// separate listener over HTTP. Pointing it at a real sandbox is a base URL
// and a credential.
//
// The rule that matters: a timeout tells you nothing about whether the
// provider issued a card. Retry blindly and you buy two. So a retry is a
// LOOKUP by request id — never a re-order.
"use strict";

class ProviderError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind; // timeout | network | http | not_found | unauthorized
    Object.assign(this, extra);
  }
}

function createProviderClient({ baseUrl, cert = "demo-partner-cert", timeoutMs = 4000, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error("provider client needs a baseUrl");
  baseUrl = baseUrl.replace(/\/$/, "");

  async function request(method, path, { body, requestId } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { "x-partner-cert": cert, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId) headers["x-request-id"] = requestId;
    let res;
    try {
      res = await fetchImpl(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      const kind = err?.name === "AbortError" ? "timeout" : "network";
      throw new ProviderError(kind, `provider ${kind} on ${method} ${path}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 401) throw new ProviderError("unauthorized", "provider rejected the partner certificate", { status: 401 });
    if (res.status === 404) throw new ProviderError("not_found", data?.error ?? "not found", { status: 404, data });
    if (!res.ok) throw new ProviderError("http", data?.message ?? data?.error ?? `provider returned ${res.status}`, { status: res.status, data });
    return data;
  }

  return {
    baseUrl,
    timeoutMs,

    async catalog() {
      const data = await request("GET", "/v1/catalog");
      return data.products ?? [];
    },

    /** Place an order. API-return mode only — there is no recipient to give. */
    async order({ productCode, requestId }) {
      if (!requestId) throw new Error("order needs a requestId (the idempotency key)");
      return request("POST", "/v1/orders", { requestId, body: { productCode, quantity: 1, delivery: "api" } });
    },

    /** Ask the provider what happened to a request id. null if it never saw it. */
    async lookup(requestId) {
      try {
        return await request("GET", `/v1/orders?requestId=${encodeURIComponent(requestId)}`);
      } catch (err) {
        if (err.kind === "not_found") return null;
        throw err;
      }
    },

    async balance(cardnbr) {
      return request("GET", `/v1/cards/${encodeURIComponent(cardnbr)}/balance`);
    },

    /**
     * Order exactly once. If the provider goes quiet — timeout, dropped
     * socket — ask it about the request id instead of ordering again.
     * Returns { order, recovered }: recovered=true means the card existed
     * and was found by lookup, not by a second order.
     */
    async orderOnce({ productCode, requestId }) {
      try {
        const order = await this.order({ productCode, requestId });
        return { order, recovered: false };
      } catch (err) {
        if (err.kind !== "timeout" && err.kind !== "network") throw err;
        const found = await this.lookup(requestId);
        if (found) return { order: found, recovered: true, after: err.kind };
        throw new ProviderError("unfulfilled", `provider ${err.kind}, and no order exists for this request id`, { after: err.kind });
      }
    },
  };
}

module.exports = { createProviderClient, ProviderError };

// The swap: burn → order → seal → settle, and the refund path.
//
//   1. requestSwap   credits burn, stock −1, the swap opens as Requested
//   2. order         the provider is asked for the product, with the swap's
//                    own request hash as the idempotency key
//   3. seal          the card is sealed to the learner's public key;
//                    the plaintext is never written down
//   4. settleSwap    a commitment — only a commitment — goes on chain
//
//   failure at 2     cancelSwap: credits and stock restored exactly
//
// Burn first, settle last. A provider outage looks like "processing" and
// then a refund — never a spent balance with nothing to show for it.
// A timeout at step 2 is resolved by asking the provider about that request
// id — never by ordering again.
"use strict";

const { hashParts, randomToken, reasonBytes32 } = require("./ids");
const sealing = require("./sealing");
const catalog = require("./catalog");

/** Turn a ledger revert into a sentence a learner can read. */
function plainError(err) {
  const a = err?.args ?? {};
  switch (err?.name) {
    case "InsufficientCredits":
      return { code: "insufficient_credits", message: `You need ${a.cost ?? a[2] ?? "more"} credits for this card and have ${a.balance ?? a[1] ?? "fewer"}.` };
    case "OutOfStock":
      return { code: "out_of_stock", message: "This card is sold out right now — the sponsor's stock for it has all been claimed." };
    case "ItemNotAvailable":
      return { code: "item_unavailable", message: "This card isn't available at the moment." };
    case "EnforcedPause":
      return { code: "paused", message: "The programme is paused right now. Nothing is lost — please try again shortly." };
    case "MissionAlreadyCompleted":
      return { code: "already_completed", message: "You've already earned credits for this mission." };
    case "MissionNotActive":
      return { code: "mission_closed", message: "This mission is not open right now." };
    case "LifetimeCapExceeded":
      return { code: "lifetime_cap", message: "This account has reached the programme's lifetime limit." };
    case "AccessControlUnauthorizedAccount":
      return { code: "unauthorized", message: "That action isn't allowed for this key." };
    case "InvalidSwap":
      return { code: "invalid_swap", message: "That swap can't be changed any more." };
    case "ProviderError":
      return { code: "provider", message: "The gift card provider didn't complete the order. Your credits have been returned." };
    case "ProviderPending":
      return { code: "provider_pending", message: "The provider has not confirmed the order yet. Your credits remain reserved while the same request is checked — no second card will be ordered." };
    default:
      return { code: "error", message: err?.message ?? "Something went wrong." };
  }
}

function createSwapService({ ledger, store, provider }) {
  const log = (event, fields) => store.log(event, fields);

  async function settleDurable(record) {
    const ledgerSwap = await ledger.swapOf(record.swapId);
    if (ledgerSwap.status === "Requested") {
      await ledger.settleSwap("fulfiller", record.swapId, record.voucherCommitment);
    } else if (ledgerSwap.status !== "Settled") {
      throw Object.assign(new Error(`cannot settle swap ${record.swapId} from ${ledgerSwap.status}`), { name: "InvalidSwap" });
    }
    record.status = "Settled";
    record.settledAt = record.settledAt ?? new Date().toISOString();
    store.swaps.put(record.swapId, record);
    log("swap.settled", { swapId: record.swapId, orderRef: record.orderRef, last4: record.last4, recovered: record.recovered });
    return publicView(record);
  }

  async function sealAndSettle(record, order, { recovered = false, after } = {}) {
    const device = store.devices.get(record.handle);
    if (!device?.publicKey) throw new Error(`device key unavailable for swap ${record.swapId}`);
    const card = order.card;
    record.sealed = sealing.seal(
      { brand: record.brand, productCode: record.productCode, valueCad: record.valueCad, cardnbr: card.cardnbr, pin: card.pin, expiry: card.expiry, orderRef: order.orderRef },
      device.publicKey
    );
    record.last4 = String(card.cardnbr).slice(-4);
    record.orderRef = order.orderRef;
    record.voucherCommitment = hashParts("voucher", record.requestHash, order.orderRef, card.cardnbr, card.pin);
    record.recovered = recovered;
    record.status = "Sealed";
    record.sealedAt = new Date().toISOString();
    // The ciphertext is durable before the irreversible ledger settlement.
    store.swaps.put(record.swapId, record);
    if (recovered) log("swap.recovered", { swapId: record.swapId, requestHash: record.requestHash, orderRef: order.orderRef, after: after ?? "restart" });
    return settleDurable(record);
  }

  async function swap({ session, itemId }) {
    const item = catalog.get(itemId);
    if (!item) throw Object.assign(new Error("unknown item"), { name: "ItemNotAvailable", args: { itemId } });
    catalog.assertClosedLoop(item); // belt and braces: never order an open-loop product
    const handle = session.handle;
    const requestHash = hashParts("swap", handle, itemId, randomToken(16));

    // 1. burn first ----------------------------------------------------------
    const swapId = await ledger.requestSwap("redeemer", handle, itemId, requestHash);
    const record = {
      swapId,
      handle,
      itemId,
      slug: item.slug,
      brand: item.brand,
      icon: item.icon,
      productCode: item.productCode,
      valueCad: item.valueCad,
      cost: item.cost,
      requestHash,
      status: "Requested",
      sealed: null,
      last4: null,
      orderRef: null,
      recovered: false,
      reveals: 0,
      createdAt: new Date().toISOString(),
    };
    store.swaps.put(swapId, record);
    log("swap.requested", { swapId, itemId: item.slug, cost: item.cost, requestHash });

    // 2. order — idempotent on the swap's own hash ---------------------------
    let order;
    try {
      const result = await provider.orderOnce({ productCode: item.productCode, requestId: requestHash });
      order = result.order;
      record.recovered = result.recovered;
    } catch (err) {
      // An ambiguous provider result is not permission to refund: a card may
      // already exist. Keep the one swap open for reconciliation or an admin
      // decision; never create a second order and never give both card+refund.
      const confirmedFailure = err.kind === "unfulfilled" || err.kind === "unauthorized" || err.kind === "not_found" || (err.kind === "http" && Number(err.status) >= 400 && Number(err.status) < 500);
      if (!confirmedFailure) {
        record.reason = `provider:${err.kind ?? "uncertain"}`;
        record.recoveryDeferredAt = new Date().toISOString();
        store.swaps.put(swapId, record);
        log("swap.recovery_deferred", { swapId, reason: record.reason });
        return { ...publicView(record), warning: plainError({ name: "ProviderPending" }) };
      }

      // 2'. confirmed failure: credits and stock restored exactly ---------------
      const reason = err.kind ? `provider:${err.kind}` : "provider:error";
      await ledger.cancelSwap("fulfiller", swapId, reasonBytes32(reason));
      record.status = "Cancelled";
      record.reason = reason;
      record.cancelledAt = new Date().toISOString();
      store.swaps.put(swapId, record);
      log("swap.cancelled", { swapId, reason, refunded: item.cost });
      return { ...publicView(record), error: plainError({ name: "ProviderError" }) };
    }

    // 3. seal durably, then 4. settle with the commitment only ----------------
    return sealAndSettle(record, order, { recovered: record.recovered, after: record.recovered ? "network" : undefined });
  }

  /** Reconcile cards issued before a process interruption without re-ordering. */
  async function recoverPending() {
    const pending = store.swaps.find((record) => record.status === "Requested" || record.status === "Sealed");
    const results = [];
    for (const record of pending) {
      try {
        if (record.status === "Sealed") {
          results.push(await settleDurable(record));
          continue;
        }
        const order = await provider.lookup(record.requestHash);
        if (!order) {
          results.push({ swapId: record.swapId, status: "Requested", recovered: false });
          continue;
        }
        results.push(await sealAndSettle(record, order, { recovered: true, after: "restart" }));
      } catch (err) {
        log("swap.recovery_deferred", { swapId: record.swapId, error: String(err?.message ?? err).slice(0, 160) });
        results.push({ swapId: record.swapId, status: record.status, error: "recovery_deferred" });
      }
    }
    return results;
  }

  /**
   * Admin-side resolution of a stuck swap. Requested is not proof that the
   * provider failed: it may have issued a card before its response was lost.
   * Reconcile the same idempotency key before refunding.
   */
  async function cancel({ swapId, reason = "admin", actor = "admin" }) {
    const record = store.swaps.get(Number(swapId));
    if (!record) throw Object.assign(new Error("the swap has no durable provider request to reconcile"), { name: "InvalidSwap" });
    if (record.status === "Sealed") return settleDurable(record);
    if (record.status !== "Requested") throw Object.assign(new Error(`cannot cancel swap ${swapId} from ${record.status}`), { name: "InvalidSwap" });
    let order;
    try {
      order = await provider.reconcile(record.requestHash);
    } catch (err) {
      log("swap.recovery_deferred", { swapId: record.swapId, reason: `admin-cancel:${err.kind ?? "uncertain"}` });
      throw Object.assign(new Error("provider lookup is still uncertain; the swap was not refunded"), { name: "ProviderPending", cause: err });
    }
    if (order) return sealAndSettle(record, order, { recovered: true, after: "admin-cancel-check" });
    throw Object.assign(new Error("provider has not returned an authoritative terminal failure; the swap was not refunded"), { name: "ProviderPending" });
  }

  /**
   * The operator's terminal decision, and the only way a learner's credits
   * come back when the provider never gave an authoritative answer.
   *
   * `cancel` above deliberately refuses to refund on an uncertain lookup —
   * that is right, because a card may exist. But "we hold your credits until
   * a machine is sure" is not a state a programme can leave a newcomer in. So
   * a human may end it, and the API makes them say out loud that they checked:
   * the request must carry confirmedNoOrder. It is a separate route and a
   * separate button from reconcile for exactly that reason.
   *
   * Even then this looks one final time. An order that exists is delivered,
   * never refunded — nobody gets both.
   */
  async function forceRefund({ swapId, reason = "admin:confirmed-no-order", actor = "admin" }) {
    const record = store.swaps.get(Number(swapId));
    if (!record) throw Object.assign(new Error(`no swap ${swapId}`), { name: "InvalidSwap" });
    if (record.status === "Sealed") return settleDurable(record);
    if (record.status !== "Requested") throw Object.assign(new Error(`cannot refund swap ${swapId} from ${record.status}`), { name: "InvalidSwap" });

    let order = null;
    try {
      order = await provider.reconcile(record.requestHash);
    } catch (err) {
      // The lookup failing is why the operator is here. It does not block them.
      log("swap.force_refund_lookup_failed", { swapId: record.swapId, kind: err?.kind ?? "uncertain" });
    }
    if (order) {
      log("swap.force_refund_refused", { swapId: record.swapId, orderRef: order.orderRef });
      return { ...(await sealAndSettle(record, order, { recovered: true, after: "force-refund-check" })), refundRefused: "an order exists for this request id; the card was delivered instead" };
    }

    const label = String(reason).slice(0, 32);
    await ledger.cancelSwap("fulfiller", record.swapId, reasonBytes32(label));
    record.status = "Cancelled";
    record.reason = label;
    record.refundedAt = new Date().toISOString();
    record.refundedBy = actor;
    store.swaps.put(record.swapId, record);
    log("swap.force_refunded", { swapId: record.swapId, reason: label, by: actor });
    return publicView(record);
  }

  /** Reveal is counted and logged: a card revealed twenty times has left the app. */
  function reveal({ session, swapId }) {
    const record = store.swaps.get(Number(swapId));
    if (!record || record.handle !== session.handle) return null;
    if (record.status !== "Settled") return null;
    record.reveals += 1;
    record.lastRevealAt = new Date().toISOString();
    store.swaps.put(record.swapId, record);
    log("card.revealed", { swapId: record.swapId, reveals: record.reveals, last4: record.last4 });
    return publicView(record);
  }

  function walletOf(session) {
    return store.swaps
      .find((r) => r.handle === session.handle)
      .sort((a, b) => b.swapId - a.swapId)
      .map(publicView);
  }

  return { swap, recoverPending, cancel, forceRefund, reveal, walletOf, plainError };
}

/** What a client may see. The sealed blob is ciphertext; the server cannot open it. */
function publicView(r) {
  return {
    swapId: r.swapId,
    itemId: r.itemId,
    slug: r.slug,
    brand: r.brand,
    icon: r.icon,
    productCode: r.productCode,
    valueCad: r.valueCad,
    cost: r.cost,
    status: r.status,
    sealed: r.sealed,
    last4: r.last4,
    orderRef: r.orderRef,
    recovered: r.recovered,
    reveals: r.reveals,
    reason: r.reason,
    createdAt: r.createdAt,
    settledAt: r.settledAt,
    cancelledAt: r.cancelledAt,
  };
}

module.exports = { createSwapService, plainError, publicView };

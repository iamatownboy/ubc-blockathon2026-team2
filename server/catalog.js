// The catalog: closed-loop products only.
//
// Every product passes assertClosedLoop before it can be listed — including
// anything synced from the provider later — and the admin console cannot
// override it. An open-loop Visa or Mastercard e-gift is money that happens
// to be shaped like a card; admitting one would defeat the premise and drag
// the whole system into PCI scope.
//
// productCode is the provider's own identifier (TIMHORTONS-CA-0500) so the
// on-chain catalog and the provider's catalog name the same thing.
// 100 credits = CAD 5.00, fixed here. There is no market and no price.
"use strict";

const { bytes32 } = require("./ids");

const CREDITS_PER_CAD = 20; // 100 credits = CAD 5.00

const OPEN_LOOP_PATTERN = /\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS|DISCOVER|PREPAID|VANILLA)\b/i;

class OpenLoopProductError extends Error {
  constructor(product) {
    super(
      `Refused to list "${product.productCode || product.brand || "?"}": open-loop products are money shaped like a card and cannot be in this catalog.`
    );
    this.name = "OpenLoopProductError";
    this.productCode = product.productCode;
  }
}

/** Throws unless the product is a closed-loop (single brand) card. */
function assertClosedLoop(product) {
  if (!product || typeof product !== "object") throw new OpenLoopProductError({});
  if (product.openLoop === true || product.closedLoop === false) throw new OpenLoopProductError(product);
  if (product.network) throw new OpenLoopProductError(product); // Visa/MC/Amex network cards carry a network field
  const haystack = [product.productCode, product.brand, product.title, product.name].filter(Boolean).join(" ");
  if (OPEN_LOOP_PATTERN.test(haystack)) throw new OpenLoopProductError(product);
  return product;
}

const creditCost = (valueCad) => Math.round(valueCad * CREDITS_PER_CAD);

function item(slug, brand, valueCad, productCode, inventory, extra = {}) {
  const product = {
    itemId: bytes32(`item:${slug}`),
    slug,
    brand,
    title: `${brand} — CAD ${valueCad} gift card`,
    productCode,
    valueCad,
    cost: creditCost(valueCad),
    inventory,
    active: true,
    closedLoop: true,
    ...extra,
  };
  return assertClosedLoop(product);
}

// The neighbourhood, as a learner in Vancouver would recognise it.
// Inventory numbers are stock a sponsor has already paid for.
const ITEMS = [
  item("tim-hortons-5", "Tim Hortons", 5, "TIMHORTONS-CA-0500", 25, {
    where: "Any Tim Hortons in Metro Vancouver",
    icon: "☕",
  }),
  item("save-on-foods-10", "Save-On-Foods", 10, "SAVEON-CA-1000", 12, {
    where: "Groceries — 20+ stores across the city",
    icon: "🛒",
  }),
  item("translink-10", "TransLink", 10, "TRANSLINK-CA-1000", 20, {
    where: "Compass top-up: bus, SkyTrain, SeaBus",
    icon: "🚌",
  }),
  item("maple-cafe-5", "Maple Café", 5, "MAPLECAFE-CA-0500", 8, {
    where: "Independent café, Commercial Drive",
    icon: "🍁",
  }),
];

const byId = new Map(ITEMS.map((i) => [i.itemId, i]));
const byProductCode = new Map(ITEMS.map((i) => [i.productCode, i]));

function all() {
  return ITEMS.map((i) => ({ ...i }));
}

function get(itemId) {
  const found = byId.get(itemId);
  return found ? { ...found } : null;
}

function getByProductCode(code) {
  const found = byProductCode.get(code);
  return found ? { ...found } : null;
}

/**
 * Accept products from the provider's catalog into ours. Every product goes
 * through assertClosedLoop; the ones that fail are returned as refused, with
 * the reason, so an open-loop card can never slip in — and the admin console
 * can show exactly what was turned away.
 */
function syncFromProvider(providerProducts) {
  const accepted = [];
  const refused = [];
  for (const p of providerProducts) {
    try {
      assertClosedLoop(p);
    } catch (err) {
      refused.push({ productCode: p.productCode, brand: p.brand, reason: err.message });
      continue;
    }
    const known = byProductCode.get(p.productCode);
    accepted.push(
      known
        ? { ...known, listed: true }
        : {
            itemId: bytes32(`item:${p.productCode.toLowerCase()}`),
            slug: p.productCode.toLowerCase(),
            brand: p.brand,
            title: `${p.brand} — CAD ${p.valueCad} gift card`,
            productCode: p.productCode,
            valueCad: p.valueCad,
            cost: creditCost(p.valueCad),
            inventory: 0,
            active: false,
            closedLoop: true,
            listed: false,
          }
    );
  }
  return { accepted, refused };
}

module.exports = {
  CREDITS_PER_CAD,
  ITEMS,
  OpenLoopProductError,
  assertClosedLoop,
  creditCost,
  all,
  get,
  getByProductCode,
  syncFromProvider,
};

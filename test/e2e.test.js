// End to end, 24 tests — the service, the mock provider and the sealed
// wallet, over real HTTP on ephemeral ports. Run: npm test
"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.COACH = "offline"; // the suite must never depend on a network

const { createApp } = require("../server/server");
const { createMockProvider, PRODUCTS: PROVIDER_PRODUCTS } = require("../server/bhn-mock");
const { MemoryLedger } = require("../server/ledger");
const sealing = require("../server/sealing");
const assessment = require("../server/assessment");
const catalog = require("../server/catalog");
const { assertNoPII, PIIRefusedError } = require("../server/store");

let mock, app, base, ledger;

beforeEach(async () => {
  mock = createMockProvider();
  const provider = await mock.listen(0);
  ledger = new MemoryLedger();
  app = createApp({ ledger, providerUrl: provider.url, providerTimeoutMs: 400, adminToken: "admin-test", verifierToken: "verifier-test" });
  await app.seed();
  base = (await app.listen(0)).url;
});

afterEach(async () => {
  await app.close();
  await mock.close();
});

// ---------------------------------------------------------------- helpers

async function call(path, { method = "GET", body, token, role } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (role) headers["x-role-token"] = role === "admin" ? "admin-test" : "verifier-test";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A learner: browser-style keypair + session. */
async function learner(language = "en") {
  const keys = sealing.generateLearnerKeypair();
  const { body } = await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, language } });
  return { ...keys, token: body.token, handle: body.handle };
}

const MISSION = assessment.MISSIONS[0];
const correctAnswers = (m = MISSION) => Object.fromEntries(m.criteria.filter((c) => c.type === "choice").map((c) => [c.id, c.answer]));
const goodAttempts = (m = MISSION) => m.prompts.map((p) => p.target);

async function pass(l, m = MISSION) {
  return call("/api/submit", { method: "POST", token: l.token, body: { missionId: m.missionId, answers: correctAnswers(m), attempts: goodAttempts(m) } });
}

async function catalogItem(slug = "tim-hortons-5") {
  const { body } = await call("/api/catalog");
  return body.items.find((i) => i.slug === slug);
}

const swapFor = (l, item) => call("/api/swap", { method: "POST", token: l.token, body: { itemId: item.itemId } });

// ---------------------------------------------------------------- identity

test("1. a session opens with a device public key, no sign-up, and the handle is 32 random bytes", async () => {
  const a = await learner();
  const b = await learner();
  assert.match(a.handle, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.handle, b.handle);
  const { status, body } = await call("/api/me", { token: a.token });
  assert.equal(status, 200);
  assert.equal(body.balance, 0);
  assert.equal(body.lifetimeCap, 15000);
  // an e-mail can't even be sent as the key
  const bad = await call("/api/session", { method: "POST", body: { publicKey: "mina@example.com" } });
  assert.equal(bad.status, 400);
});

test("2. the store refuses to write a name, e-mail, phone, address or device id", async () => {
  for (const row of [{ name: "Mina" }, { contact: "mina@example.com" }, { phone: "604-555-0199" }, { note: "call (604) 555-0199" }, { address: "123 Main St" }, { deviceId: "abc" }, { cardnbr: "1" }]) {
    assert.throws(() => assertNoPII(row), PIIRefusedError, JSON.stringify(row));
  }
  assert.throws(() => app.store.sessions.put("x", { handle: "0xabc", email: "a@b.co" }), PIIRefusedError);
  assertNoPII({ handle: "0x" + "1".repeat(64), last4: "8458", sealed: { ct: "AAAA" } }); // fine
});

// ---------------------------------------------------------------- coach

test("3. the coach filter strips pass and credits from the offline coach", () => {
  const raw = assessment.offlineCoach({ mission: MISSION, attempts: goodAttempts(), language: "en" });
  assert.equal(raw.pass, true);
  assert.equal(raw.credits, 999999);
  const filtered = assessment.filterCoach(raw, "en");
  assert.deepEqual(Object.keys(filtered).sort(), [...assessment.COACH_FIELDS].sort());
  assert.equal("pass" in filtered, false);
  assert.equal("credits" in filtered, false);
  // and the live coach's schema has no room for them either
  assert.equal("pass" in assessment.COACH_SCHEMA.properties, false);
  assert.equal("credits" in assessment.COACH_SCHEMA.properties, false);
  assert.equal(assessment.COACH_SCHEMA.additionalProperties, false);
});

test("4. over the API the coach returns corrections in the learner's language and nothing that could pay", async () => {
  const l = await learner("ko");
  const { status, body } = await call("/api/coach", { method: "POST", token: l.token, body: { missionId: MISSION.missionId, attempts: ["do you have english group?", "when group meet?", "again please?"] } });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.feedback).sort(), ["corrections", "encouragement", "explanation", "language"]);
  assert.equal(body.feedback.language, "ko");
  assert.equal(body.feedback.corrections.length, 3);
  assert.equal(body.feedback.corrections[0].better, MISSION.prompts[0].target);
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 0); // talking to the coach pays nothing
});

// ---------------------------------------------------------------- grading

test("5. a tampered submission awards nothing", async () => {
  const l = await learner();
  const { body } = await call("/api/submit", {
    method: "POST",
    token: l.token,
    body: { missionId: MISSION.missionId, answers: { q1: 0, q2: 0, q3: 1 }, attempts: ["hello"], pass: true, passed: true, credits: 999999, amount: 5000 },
  });
  assert.equal(body.outcome, "failed");
  assert.equal(body.awarded, undefined);
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 0);
});

test("6. a passed mission pays the configured 100 credits, once", async () => {
  const l = await learner();
  const { body } = await pass(l);
  assert.equal(body.outcome, "passed");
  assert.equal(body.awarded, 100);
  assert.equal(body.balance, 100);
  const again = await pass(l);
  assert.equal(again.body.awarded, 0);
  assert.equal(again.body.notAwarded.code, "already_completed");
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 100);
  const missions = (await call("/api/missions", { token: l.token })).body.missions;
  assert.equal(missions.find((m) => m.missionId === MISSION.missionId).completed, true);
});

test("7. a near miss goes to the review queue with the criterion it missed", async () => {
  const l = await learner();
  const attempts = ["Hi! Do you have an English group here?", "When does it meet?", "Could you repeat that?"]; // no "conversation group"
  const { body } = await call("/api/submit", { method: "POST", token: l.token, body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts } });
  assert.equal(body.outcome, "review");
  assert.deepEqual(body.missed, ["phrase"]);
  const queue = (await call("/api/verifier/queue", { role: "verifier" })).body.queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].handle, l.handle);
  assert.deepEqual(queue[0].missed, ["phrase"]);
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 0);
});

test("8. the verifier console awards the configured amount and ignores an amount in the request", async () => {
  const l = await learner();
  const { body } = await call("/api/submit", { method: "POST", token: l.token, body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts: ["Hi! Is there an English group?"] } });
  const approve = await call(`/api/verifier/queue/${body.reviewId}/approve`, { method: "POST", role: "verifier", body: { amount: 5000, credits: 5000 } });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.awarded, 100);
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 100);
  assert.ok(app.store.logEntries.some((e) => e.event === "verifier.amount_ignored"));
  const twice = await call(`/api/verifier/queue/${body.reviewId}/approve`, { method: "POST", role: "verifier" });
  assert.equal(twice.status, 409);
});

test("9. the verifier can reject, and the consoles are token-gated", async () => {
  const l = await learner();
  const { body } = await call("/api/submit", { method: "POST", token: l.token, body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts: ["Hi! Is there an English group?"] } });
  assert.equal((await call("/api/verifier/queue")).status, 401);
  assert.equal((await call("/api/admin/state")).status, 401);
  assert.equal((await call("/api/verifier/queue", { role: "admin" })).status, 401); // the admin token is not a verifier token
  const reject = await call(`/api/verifier/queue/${body.reviewId}/reject`, { method: "POST", role: "verifier" });
  assert.equal(reject.body.status, "rejected");
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 0);
});

test("10. three missions are open and each pays once; the balance shows its expiry", async () => {
  const l = await learner();
  for (const m of assessment.MISSIONS) assert.equal((await pass(l, m)).body.awarded, 100);
  const me = (await call("/api/me", { token: l.token })).body;
  assert.equal(me.balance, 300);
  assert.equal(me.lifetimeAwarded, 300);
  assert.ok(me.expiresAt > Date.now() / 1000 + 364 * 86400);
});

// ---------------------------------------------------------------- catalog

test("11. every catalog product is closed loop and priced at 20 credits per dollar", async () => {
  const { body } = await call("/api/catalog");
  assert.ok(body.items.length >= 4);
  for (const item of body.items) {
    assert.doesNotThrow(() => catalog.assertClosedLoop(item));
    assert.equal(item.cost, item.valueCad * 20);
    assert.ok(item.inventory > 0, `${item.slug} has stock`);
  }
  assert.ok(body.items.some((i) => i.productCode === "TIMHORTONS-CA-0500" && i.cost === 100));
});

test("12. an open-loop product is refused — by the catalog rule and by the admin console", async () => {
  assert.throws(() => catalog.syncFromProvider(PROVIDER_PRODUCTS), catalog.OpenLoopProductError);
  const closedOnly = PROVIDER_PRODUCTS.filter((p) => !p.openLoop);
  assert.equal(catalog.syncFromProvider(closedOnly).length, closedOnly.length);
  for (const p of [{ productCode: "VISA-CA-2500", brand: "Visa Prepaid" }, { productCode: "X-1", brand: "Mastercard Gift" }, { productCode: "X-2", brand: "Anything", network: "VISA" }, { productCode: "X-3", brand: "Anything", openLoop: true }]) {
    assert.throws(() => catalog.assertClosedLoop(p), catalog.OpenLoopProductError, p.productCode);
  }
  const res = await call("/api/admin/catalog", { method: "POST", role: "admin", body: { itemId: "0x" + "ab".repeat(32), productCode: "VISA-CA-2500", brand: "Visa Prepaid", cost: 500, inventory: 10, active: true } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "open_loop_refused");
});

// ---------------------------------------------------------------- swap

test("13. a swap delivers a card the learner's key opens", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  const { status, body } = await swapFor(l, item);
  assert.equal(status, 200);
  assert.equal(body.status, "Settled");
  assert.equal(body.balance, 0);
  assert.ok(body.sealed && body.sealed.ct && !("cardnbr" in body));
  const card = sealing.open(body.sealed, l.privateKey);
  assert.equal(card.brand, "Tim Hortons");
  assert.match(card.cardnbr, /^\d{16}$/);
  assert.match(card.pin, /^\d{4}$/);
  assert.equal(card.cardnbr.slice(-4), body.last4);
  const wallet = (await call("/api/wallet", { token: l.token })).body.cards;
  assert.equal(wallet.length, 1);
  assert.equal(wallet[0].swapId, body.swapId);
});

test("14. a stranger's key cannot open the card, and the server holds only ciphertext", async () => {
  const l = await learner();
  await pass(l);
  const { body } = await swapFor(l, await catalogItem());
  const stranger = sealing.generateLearnerKeypair();
  assert.throws(() => sealing.open(body.sealed, stranger.privateKey));
  const stored = app.store.swaps.get(body.swapId);
  assert.equal(stored.sealed.alg, sealing.ALG);
  assert.equal(JSON.stringify(stored).includes(sealing.open(body.sealed, l.privateKey).cardnbr), false);
});

test("15. the card is real at the provider's balance endpoint, and the provider takes no recipient", async () => {
  const l = await learner();
  await pass(l);
  const { body } = await swapFor(l, await catalogItem());
  const card = sealing.open(body.sealed, l.privateKey);
  const balance = await app.provider.balance(card.cardnbr);
  assert.equal(balance.balance, 5);
  assert.equal(balance.currency, "CAD");
  assert.equal(balance.productCode, "TIMHORTONS-CA-0500");
  // API-return mode only: the order endpoint refuses a recipient block outright
  const res = await fetch(mock.server.address() && `http://127.0.0.1:${mock.server.address().port}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-partner-cert": "demo-partner-cert", "x-request-id": "0xtest" },
    body: JSON.stringify({ productCode: "TIMHORTONS-CA-0500", quantity: 1, recipient: { email: "mina@example.com" } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "recipient_not_supported");
});

test("16. burn first: credits and one unit of stock leave before the provider is called", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  const before = item.inventory;
  const { body } = await swapFor(l, item);
  assert.equal(body.status, "Settled");
  assert.equal((await catalogItem()).inventory, before - 1);
  const events = (await ledger.events()).map((e) => e.name);
  assert.ok(events.indexOf("SwapRequested") < events.indexOf("SwapSettled"));
  const log = app.store.logEntries.map((e) => e.event);
  assert.ok(log.indexOf("swap.requested") < log.indexOf("swap.settled"));
  assert.equal(mock.state.orders.size, 1);
});

test("17. a provider error refunds: credits and stock come back, nothing is settled", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  mock.setMode("error");
  const { status, body } = await swapFor(l, item);
  assert.equal(status, 200);
  assert.equal(body.status, "Cancelled");
  assert.equal(body.error.code, "provider");
  assert.equal(body.balance, 100);
  assert.equal((await catalogItem()).inventory, item.inventory);
  assert.equal(mock.state.orders.size, 0);
  assert.equal((await ledger.stats()).swapped, 0);
  // the failure switch was one-shot; the next swap goes through
  assert.equal((await swapFor(l, item)).body.status, "Settled");
});

test("18. a provider timeout with no card issued is a refund, found by lookup — not a re-order", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  mock.setMode("timeout");
  const { body } = await swapFor(l, item);
  assert.equal(body.status, "Cancelled");
  assert.equal(body.reason, "provider:unfulfilled");
  assert.equal(body.balance, 100);
  assert.equal((await catalogItem()).inventory, item.inventory);
  assert.ok(mock.state.log.some((e) => e.event === "order.lookup" && e.found === false));
  assert.equal(mock.state.log.filter((e) => e.event === "order.hung").length, 1); // exactly one order attempt
});

test("19. a ghosted order is recovered rather than re-ordered: one order, one card, one unit of stock", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  mock.setMode("ghost");
  const { body } = await swapFor(l, item);
  assert.equal(body.status, "Settled");
  assert.equal(body.recovered, true);
  assert.equal(mock.state.orders.size, 1);
  assert.equal(mock.state.cards.size, 1);
  assert.equal(mock.state.counters.orders, 1);
  assert.equal((await catalogItem()).inventory, item.inventory - 1);
  assert.equal((await ledger.stats()).swapped, 100);
  const card = sealing.open(body.sealed, l.privateKey);
  assert.equal((await app.provider.balance(card.cardnbr)).balance, 5);
  assert.ok(app.store.logEntries.some((e) => e.event === "swap.recovered"));
});

// ---------------------------------------------------------------- pause & errors

test("20. pause blocks earning and swapping; unpause restores both", async () => {
  const l = await learner();
  await pass(l);
  assert.equal((await call("/api/admin/pause", { method: "POST", role: "admin" })).body.paused, true);
  const blocked = await pass(l, assessment.MISSIONS[1]);
  assert.equal(blocked.body.awarded, 0);
  assert.equal(blocked.body.notAwarded.code, "paused");
  const swap = await swapFor(l, await catalogItem());
  assert.equal(swap.status, 409);
  assert.equal(swap.body.error, "paused");
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 100);
  await call("/api/admin/unpause", { method: "POST", role: "admin" });
  assert.equal((await swapFor(l, await catalogItem())).body.status, "Settled");
});

test("21. an empty balance, empty stock and a pause each read as a plain sentence, not a revert string", async () => {
  const l = await learner();
  const item = await catalogItem("maple-cafe-5");
  const empty = await swapFor(l, item);
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error, "insufficient_credits");
  assert.match(empty.body.message, /You need 100 credits/);

  await call("/api/admin/catalog", { method: "POST", role: "admin", body: { itemId: item.itemId, inventory: 0 } });
  await pass(l);
  const none = await swapFor(l, item);
  assert.equal(none.body.error, "out_of_stock");
  assert.match(none.body.message, /sold out/);

  await call("/api/admin/pause", { method: "POST", role: "admin" });
  const paused = await swapFor(l, await catalogItem());
  assert.match(paused.body.message, /paused/);
  for (const m of [empty.body.message, none.body.message, paused.body.message]) {
    assert.doesNotMatch(m, /revert|0x|InsufficientCredits|OutOfStock|EnforcedPause/);
    assert.match(m, /[.!]$/);
  }
});

// ---------------------------------------------------------------- privacy & audit

test("22. no card number, pin, or name anywhere in the logs, the store, or the events", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  const { body } = await swapFor(l, item);
  await call(`/api/wallet/${body.swapId}/reveal`, { method: "POST", token: l.token });
  const card = sealing.open(body.sealed, l.privateKey);
  const haystack = JSON.stringify(app.store.dump()) + JSON.stringify(await ledger.events()) + JSON.stringify((await call("/api/admin/state", { role: "admin" })).body) + JSON.stringify((await call("/api/admin/log", { role: "admin" })).body);
  assert.equal(haystack.includes(card.cardnbr), false, "card number leaked");
  assert.equal(haystack.includes(`"${card.pin}"`), false, "pin leaked");
  assert.equal(/mina|@/.test(haystack), false);
  // every ledger event field is a hex id, a number or a boolean — nothing can carry a name
  for (const e of await ledger.events()) {
    if (e.name.startsWith("Role") || e.name === "Paused" || e.name === "Unpaused") continue;
    for (const [k, v] of Object.entries(e.args)) {
      assert.ok(typeof v === "number" || typeof v === "boolean" || /^0x[0-9a-f]{64}$/.test(v), `${e.name}.${k} = ${v}`);
    }
  }
});

test("23. /api/stats is readable with no login and the ledger conserves credits", async () => {
  const a = await learner();
  const b = await learner();
  await pass(a);
  await pass(b);
  await swapFor(a, await catalogItem());
  mock.setMode("error");
  await swapFor(b, await catalogItem());
  const { status, body } = await call("/api/stats");
  assert.equal(status, 200);
  const s = body.ledger;
  assert.equal(s.awarded, s.outstanding + s.inSwap + s.swapped + s.expired);
  assert.deepEqual({ awarded: s.awarded, swapped: s.swapped, outstanding: s.outstanding }, { awarded: 200, swapped: 100, outstanding: 100 });
  assert.deepEqual(body.swaps, { requested: 0, settled: 1, cancelled: 1, recovered: 0 });
  assert.equal(body.learners, 2);
  assert.equal(body.limits.maxMissionReward, 2000);
  assert.ok(body.catalog.every((c) => typeof c.inventory === "number"));
  assert.equal(JSON.stringify(body).includes(a.handle), false); // aggregate only — no handles
});

test("24. every reveal is counted and logged, and only the owner's device can ask", async () => {
  const l = await learner();
  await pass(l);
  const { body } = await swapFor(l, await catalogItem());
  const other = await learner();
  assert.equal((await call(`/api/wallet/${body.swapId}/reveal`, { method: "POST", token: other.token })).status, 404);
  await call(`/api/wallet/${body.swapId}/reveal`, { method: "POST", token: l.token });
  const second = await call(`/api/wallet/${body.swapId}/reveal`, { method: "POST", token: l.token });
  assert.equal(second.body.reveals, 2);
  assert.equal(app.store.logEntries.filter((e) => e.event === "card.revealed" && e.swapId === body.swapId).length, 2);
  const wallet = (await call("/api/wallet", { token: l.token })).body.cards;
  assert.equal(wallet[0].reveals, 2);
});

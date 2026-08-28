// End to end, 24 tests — the service, the mock provider and the sealed
// wallet, over real HTTP on ephemeral ports. Run: npm test
"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.COACH = "offline"; // the suite must never depend on a network

const { createApp } = require("../server/server");
const { createMockProvider, PRODUCTS: PROVIDER_PRODUCTS } = require("../server/bhn-mock");
const { MemoryLedger } = require("../server/ledger");
const sealing = require("../server/sealing");
const assessment = require("../server/assessment");
const catalog = require("../server/catalog");
const { Store, assertNoPII, PIIRefusedError } = require("../server/store");
const { hashParts } = require("../server/ids");
const { createEnrollment } = require("../server/enrollment");
const { createRateLimiter, clientKey } = require("../server/ratelimit");
const { code: makeCode, ALPHABET } = require("../scripts/make-codes");

let mock, app, base, ledger, providerBase, enrollment;
let tempDirs;
let codeSeq;

/** Plenty of partner-issued codes, so each test learner is a different person. */
const TEST_CODES = Array.from({ length: 60 }, (_, i) => `TEST-CODE-${String(i).padStart(2, "0")}`);
const nextCode = () => TEST_CODES[codeSeq++ % TEST_CODES.length];

beforeEach(async () => {
  mock = createMockProvider();
  const provider = await mock.listen(0);
  providerBase = provider.url;
  tempDirs = [];
  ledger = new MemoryLedger();
  codeSeq = 0;
  enrollment = createEnrollment({ secret: "test-identity-secret", codes: TEST_CODES });
  app = createApp({ ledger, providerUrl: provider.url, providerTimeoutMs: 400, adminToken: "admin-test", verifierToken: "verifier-test", enrollment });
  await app.seed();
  base = (await app.listen(0)).url;
});

afterEach(async () => {
  await app.close();
  await mock.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

async function call(path, { method = "GET", body, token, role } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (role) headers["x-role-token"] = role === "admin" ? "admin-test" : "verifier-test";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** A learner: browser-style keypair + session. */
async function learner(language = "en", code = null) {
  const keys = sealing.generateLearnerKeypair();
  const enrollmentCode = code ?? nextCode();
  const { body } = await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, language, enrollmentCode } });
  return { ...keys, token: body.token, handle: body.handle, code: enrollmentCode };
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

test("1. a session opens with no sign-up and the participation code recovers the same private handle", async () => {
  const a = await learner();
  const b = await learner();
  assert.match(a.handle, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.handle, b.handle);
  // A brand new device key — a cleared browser, a borrowed phone — with the
  // same paper code lands back on the same learner.
  const fresh = sealing.generateLearnerKeypair();
  const reopened = await call("/api/session", { method: "POST", body: { publicKey: fresh.publicJwk, language: "en", enrollmentCode: a.code } });
  assert.equal(reopened.body.handle, a.handle);
  assert.notEqual(reopened.body.token, a.token);
  const { status, body } = await call("/api/me", { token: a.token });
  assert.equal(status, 200);
  assert.equal(body.balance, 0);
  assert.equal(body.lifetimeCap, 15000);
  // an e-mail can't even be sent as the key
  const bad = await call("/api/session", { method: "POST", body: { publicKey: "mina@example.com" } });
  assert.equal(bad.status, 400);
});

test("1b. a cleared browser cannot reset rewards, mission completion or the lifetime cap", async () => {
  const l = await learner();
  await pass(l);
  // "Forget this device" is the attack: wipe the browser, come back new, earn
  // the same reward again. A fresh device key with the same paper code lands
  // on the same handle, so there is nothing to reset.
  const wiped = sealing.generateLearnerKeypair();
  const reopened = await call("/api/session", { method: "POST", body: { publicKey: wiped.publicJwk, language: "en", enrollmentCode: l.code } });
  assert.equal(reopened.body.handle, l.handle);
  assert.equal((await call("/api/me", { token: reopened.body.token })).body.balance, 100);
  const duplicate = await call("/api/submit", {
    method: "POST",
    token: reopened.body.token,
    body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts: goodAttempts() },
  });
  assert.equal(duplicate.body.notAwarded.code, "already_completed");
});

test("1c. a session needs a partner-issued code, and an unissued one is refused", async () => {
  const keys = sealing.generateLearnerKeypair();
  const none = await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk } });
  assert.equal(none.status, 403);
  assert.equal(none.body.error, "enrollment_required");
  const bogus = await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, enrollmentCode: "TEST-CODE-99999" } });
  assert.equal(bogus.status, 403);
  assert.equal(bogus.body.error, "enrollment_invalid");
  // A nervous typist still gets in: case, spaces and dashes do not matter.
  const typo = await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, enrollmentCode: " test code 00 " } });
  assert.equal(typo.status, 200);
  assert.equal(typo.body.handle, (await call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, enrollmentCode: "TEST-CODE-00" } })).body.handle);
});

test("1d. wiping the browser after a swap does not buy a second card on the same code", async () => {
  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  assert.equal((await swapFor(l, item)).body.status, "Settled");
  assert.equal((await call("/api/me", { token: l.token })).body.balance, 0);

  // The learner clears the site data and starts over with the same paper code.
  const wiped = sealing.generateLearnerKeypair();
  const again = await call("/api/session", { method: "POST", body: { publicKey: wiped.publicJwk, enrollmentCode: l.code } });
  const token = again.body.token;
  const me = (await call("/api/me", { token })).body;
  assert.equal(again.body.handle, l.handle);
  assert.equal(me.balance, 0);
  assert.equal(me.lifetimeAwarded, 100); // the cap followed the person, not the browser
  const redo = await call("/api/submit", { method: "POST", token, body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts: goodAttempts() } });
  assert.equal(redo.body.notAwarded.code, "already_completed");
  assert.equal((await call("/api/me", { token })).body.balance, 0);
});

test("1e. the participation code itself is never stored or logged", async () => {
  const l = await learner();
  const dumped = JSON.stringify(app.store.dump());
  assert.ok(!dumped.includes(l.code), "the code must not appear anywhere in the store");
  assert.ok(dumped.includes(l.handle), "the one-way handle is what is kept");
  const { body } = await call("/api/enrollment");
  assert.equal(body.required, true);
  assert.deepEqual(body.demoCodes, []); // an explicit code list is never echoed back
});

test("1f. the ledger mode is reported to the learner, so a mirror run is never shown as on-chain", async () => {
  const l = await learner();
  assert.equal((await call("/api/me", { token: l.token })).body.ledgerMode, "memory");
});

test("1g. a production deployment cannot fall back to the demo code list", async () => {
  assert.throws(
    () => createEnrollment({ secret: "s", production: true }),
    /ENROLLMENT_CODES/,
    "production with no partner code list must refuse to start"
  );
  const open = createEnrollment({ secret: "s", mode: "open", production: true });
  assert.equal(open.required, false); // an explicit, documented opt-out
  const demo = createEnrollment({ secret: "s", production: false });
  assert.ok(demo.demoCodes.length > 0 && demo.required);
});

test("1h. guessing participation codes is throttled, and a correct one forgives the typos", async () => {
  const keys = sealing.generateLearnerKeypair();
  const guess = (c) => call("/api/session", { method: "POST", body: { publicKey: keys.publicJwk, enrollmentCode: c } });

  // The service ships an eight-per-window limit; the suite must not depend on
  // the exact number, only that guessing stops before the code space does.
  const limit = app.codeAttempts.limit;
  for (let i = 0; i < limit; i += 1) {
    const r = await guess(`NOT-A-CODE-${i}`);
    assert.equal(r.status, 403, `guess ${i + 1} should still be a plain refusal`);
    assert.equal(r.body.error, "enrollment_invalid");
  }
  const blocked = await guess("NOT-A-CODE-again");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "too_many_attempts");
  assert.ok(blocked.body.retryAfterSeconds > 0);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);

  // Even a *valid* code is refused while the address is cooling off — the
  // limit is on the address, not on whether the guess happened to be right.
  assert.equal((await guess(TEST_CODES[0])).status, 429);

  // Nothing about the caller or the attempted codes reaches the store.
  const dumped = JSON.stringify(app.store.dump());
  assert.ok(!dumped.includes("NOT-A-CODE"), "attempted codes must never be stored");
  assert.ok(!dumped.includes("127.0.0.1") && !dumped.includes("::1"), "the caller's address must never be stored");

  // A correct code clears the count for that address.
  app.codeAttempts.clear(clientKey({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }));
  app.codeAttempts.clear("::1");
  app.codeAttempts.clear("::ffff:127.0.0.1");
  const ok = await guess(TEST_CODES[1]);
  assert.equal(ok.status, 200);
  const after = await guess("NOT-A-CODE-later");
  assert.equal(after.status, 403, "a success resets the window, so plain refusals resume");
});

test("1i. the limiter counts a window, not a lifetime, and never trusts a client header", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
  assert.equal(limiter.retryAfterMs("a"), 0);
  limiter.record("a");
  limiter.record("a");
  assert.ok(limiter.retryAfterMs("a") > 0, "the third try waits");
  assert.equal(limiter.retryAfterMs("b"), 0, "one address cannot lock out another");
  clock = 1001;
  assert.equal(limiter.retryAfterMs("a"), 0, "the window slides");

  const req = { socket: { remoteAddress: "203.0.113.9" }, headers: { "x-forwarded-for": "1.2.3.4" } };
  assert.equal(clientKey(req), "203.0.113.9", "a header must not be able to reset the counter");
  assert.equal(clientKey(req, { trustProxy: true }), "1.2.3.4", "unless the operator says a proxy sets it");
});

test("1j. issued codes carry real entropy and no ambiguous characters", () => {
  assert.equal(ALPHABET.length, 32);
  for (const bad of ["O", "0", "I", "1"]) assert.ok(!ALPHABET.includes(bad), `${bad} is too easy to misread aloud`);
  const codes = new Set(Array.from({ length: 500 }, () => makeCode()));
  assert.equal(codes.size, 500, "500 generated codes must not collide");
  for (const c of codes) assert.match(c, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
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
  const stored = app.store.submissions.values();
  assert.ok(stored.length >= 1);
  assert.equal(stored.some((row) => "answers" in row || "attempts" in row), false);
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
  const decided = app.store.reviewQueue.get(body.reviewId);
  assert.equal(decided.status, "approved");
  assert.equal("answers" in decided, false);
  assert.equal("attempts" in decided, false);
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
  assert.equal("attempts" in app.store.reviewQueue.get(body.reviewId), false);
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
  const sync = catalog.syncFromProvider(PROVIDER_PRODUCTS);
  assert.equal(sync.accepted.length, PROVIDER_PRODUCTS.filter((p) => !p.openLoop).length);
  assert.deepEqual(sync.refused.map((r) => r.productCode), ["VISA-CA-2500"]);
  const viaApi = await call("/api/admin/catalog/sync", { method: "POST", role: "admin" });
  assert.equal(viaApi.status, 200);
  assert.deepEqual(viaApi.body.refused.map((r) => r.productCode), ["VISA-CA-2500"]);
  assert.ok(viaApi.body.accepted.every((p) => p.closedLoop));
  for (const p of [{ productCode: "VISA-CA-2500", brand: "Visa Prepaid" }, { productCode: "X-1", brand: "Mastercard Gift" }, { productCode: "X-2", brand: "Anything", network: "VISA" }, { productCode: "X-3", brand: "Anything", openLoop: true }]) {
    assert.throws(() => catalog.assertClosedLoop(p), catalog.OpenLoopProductError, p.productCode);
  }
  const res = await call("/api/admin/catalog", { method: "POST", role: "admin", body: { itemId: "0x" + "ab".repeat(32), productCode: "VISA-CA-2500", brand: "Visa Prepaid", cost: 500, inventory: 10, active: true } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "unapproved_product");
});

test("12a2. a closed-loop product the programme never approved syncs as unlisted and still cannot be configured", async () => {
  const { body } = await call("/api/admin/catalog/sync", { method: "POST", role: "admin" });
  const petro = body.accepted.find((p) => p.productCode === "PETROCAN-CA-2500");
  // It is not open loop, so it is not refused outright — the provider really sells it.
  assert.ok(petro, "a closed-loop provider product must come back accepted");
  assert.equal(petro.listed, false, "but being in the provider's catalog is not programme approval");
  assert.ok(body.accepted.filter((p) => p.listed).every((p) => catalog.get(p.itemId)));
  // And the console cannot turn it into a listed item.
  const res = await call("/api/admin/catalog", {
    method: "POST",
    role: "admin",
    body: { itemId: petro.itemId, productCode: petro.productCode, cost: petro.cost, inventory: 5, active: true },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "unapproved_product");
  assert.equal((await call("/api/catalog")).body.items.find((i) => i.productCode === "PETROCAN-CA-2500"), undefined);
});

test("12c3. the learner app is usable without sight or a steady hand", async () => {
  const get = async (p) => (await fetch(base + p)).text();
  const [html, i18n, appjs, css] = await Promise.all([
    get("/learner/"),
    get("/learner/i18n.js"),
    get("/learner/app.js"),
    get("/common.css"),
  ]);

  // The document must declare the language it is actually in, or a screen
  // reader announces 한국어 and 中文 with an English voice.
  assert.match(i18n, /documentElement/);
  assert.match(i18n, /el\.lang = current/);

  // Status and errors have to be announced, not just coloured.
  assert.match(html, /id="toast"[^>]*role="status"/);
  assert.match(html, /id="toast"[^>]*aria-live/);
  assert.match(appjs, /aria-live", kind === "red" \? "assertive"/);

  // Replacing the page contents must move focus, or the new screen is silent.
  assert.match(html, /<main id="app" tabindex="-1">/);
  assert.match(appjs, /\$app\.focus\(/);
  assert.match(appjs, /aria-current="page"/);
  assert.match(appjs, /aria-hidden="true"/); // the emoji are decoration

  // The reader's own text size and motion settings win.
  assert.doesNotMatch(css, /body \{[^}]*font-size: 16px/);
  assert.match(css, /font-size: 1rem/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /min-height: 48px/); // tap targets on the bottom nav
});

test("12b. the admin cannot substitute a product code on an approved item", async () => {
  const item = await catalogItem();
  const res = await call("/api/admin/catalog", {
    method: "POST",
    role: "admin",
    body: { itemId: item.itemId, productCode: "OTHER-BRAND-0500", inventory: 10 },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "unapproved_product");
});

test("12c. API responses carry browser security headers", async () => {
  const res = await call("/api/catalog");
  const csp = res.headers.get("content-security-policy");
  // 'self', not 'none': the demo stage frames the learner app from this same
  // origin. Anything outside the origin still cannot frame it, and that is
  // what the header has to keep guaranteeing.
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /frame-ancestors [^;]*\*/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("12c2. the demo stage is served and asks for no token", async () => {
  const page = await fetch(base + "/demo/");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /demo\/app\.js/);
  const script = await (await fetch(base + "/demo/app.js")).text();
  // The projected screen must not carry an admin secret: it may read only the
  // two endpoints that need none.
  assert.doesNotMatch(script, /x-role-token|adminToken|verifierToken/);
  for (const path of ["/api/stats", "/api/events", "/api/enrollment"]) {
    assert.equal((await fetch(base + path)).status, 200, `${path} must be readable with no token`);
  }
  assert.equal((await fetch(base + "/api/admin/log")).status, 401);
});

test("12d. abandoned review text expires and is removed", async () => {
  const l = await learner();
  const submitted = await call("/api/submit", {
    method: "POST",
    token: l.token,
    body: { missionId: MISSION.missionId, answers: correctAnswers(), attempts: ["Hi! Is there an English group?"] },
  });
  const row = app.store.reviewQueue.get(submitted.body.reviewId);
  row.reviewExpiresAt = new Date(Date.now() - 1000).toISOString();
  app.store.reviewQueue.put(row.id, row);
  await call("/api/verifier/queue", { role: "verifier" });
  const expired = app.store.reviewQueue.get(row.id);
  assert.equal(expired.status, "expired");
  assert.equal("answers" in expired, false);
  assert.equal("attempts" in expired, false);
});

test("12e. proof commitments bind the graded attempts and canonical answers", () => {
  const nonce = "fixed-nonce";
  const a = assessment.proofHash("learner", MISSION, { answers: { b: 2, a: 1 }, attempts: ["one"] }, nonce);
  const reordered = assessment.proofHash("learner", MISSION, { answers: { a: 1, b: 2 }, attempts: ["one"] }, nonce);
  const changedAttempt = assessment.proofHash("learner", MISSION, { answers: { a: 1, b: 2 }, attempts: ["two"] }, nonce);
  assert.equal(a, reordered);
  assert.notEqual(a, changedAttempt);
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

test("19b. a provider-issued card is recovered after an app restart without a second order", async () => {
  await app.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "languagetoken-recovery-"));
  tempDirs.push(dir);
  const stateFile = path.join(dir, "state.json");
  app = createApp({
    ledger,
    store: new Store({ file: stateFile }),
    providerUrl: providerBase,
    providerTimeoutMs: 400,
    adminToken: "admin-test",
    verifierToken: "verifier-test",
    enrollment,
  });
  await app.seed();
  base = (await app.listen(0)).url;

  const l = await learner();
  await pass(l);
  const item = await catalogItem();
  const requestHash = hashParts("restart-test", l.handle, item.itemId);
  const swapId = await ledger.requestSwap("redeemer", l.handle, item.itemId, requestHash);
  app.store.swaps.put(swapId, {
    swapId,
    handle: l.handle,
    itemId: item.itemId,
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
  });
  await app.provider.order({ productCode: item.productCode, requestId: requestHash });
  assert.equal(mock.state.orders.size, 1);

  await app.close();
  app = createApp({
    ledger,
    store: new Store({ file: stateFile }),
    providerUrl: providerBase,
    providerTimeoutMs: 400,
    adminToken: "admin-test",
    verifierToken: "verifier-test",
    enrollment,
  });
  await app.seed();
  base = (await app.listen(0)).url;

  const resumed = await call("/api/session", { method: "POST", body: { publicKey: l.publicJwk, language: "en", enrollmentCode: l.code } });
  assert.equal(resumed.body.handle, l.handle);
  const wallet = (await call("/api/wallet", { token: resumed.body.token })).body.cards;
  assert.equal(wallet.length, 1);
  assert.equal(wallet[0].status, "Settled");
  assert.equal(wallet[0].recovered, true);
  assert.equal(mock.state.orders.size, 1);
  assert.equal(mock.state.cards.size, 1);
  assert.equal(sealing.open(wallet[0].sealed, l.privateKey).orderRef, wallet[0].orderRef);
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

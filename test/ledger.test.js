// Ledger, 27 tests — the contract's rules, exercised on the JS mirror.
// Run: npm test   (node --test, no toolchain)
"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MemoryLedger, ROLES, MAX_MISSION_REWARD, LIFETIME_CAP, CREDIT_TTL, REFUND_GRACE_PERIOD } = require("../server/ledger");
const { bytes32, reasonBytes32, reasonFromBytes32 } = require("../server/ids");

const LEARNER = bytes32("learner:mina");
const LEARNER_2 = bytes32("learner:jun");
const MISSION = bytes32("mission:library");
const MISSION_2 = bytes32("mission:pharmacy");
const ITEM = bytes32("item:tim-hortons-5");
const PRODUCT = bytes32("product:TIMHORTONS-CA-0500");
const PROOF = bytes32("proof:1");
const REQUEST = bytes32("request:1");
const COMMITMENT = bytes32("voucher:1");
const REWARD = 100;
const COST = 100;
const STOCK = 3;

let ledger;
let clock;

const rejects = (promise, name) =>
  assert.rejects(promise, (err) => {
    assert.equal(err.name, name, `expected ${name}, got ${err.name}: ${err.message}`);
    return true;
  });

beforeEach(async () => {
  clock = 1_800_000_000;
  ledger = new MemoryLedger({ now: () => clock });
  await ledger.grantRole("admin", ROLES.VERIFIER_ROLE, "verifier");
  await ledger.grantRole("admin", ROLES.REDEEMER_ROLE, "redeemer");
  await ledger.grantRole("admin", ROLES.FULFILLER_ROLE, "fulfiller");
  await ledger.configureMission("admin", MISSION, REWARD, 1, true);
  await ledger.configureMission("admin", MISSION_2, REWARD, 1, true);
  await ledger.configureCatalogItem("admin", ITEM, PRODUCT, COST, STOCK, true);
});

const award = (learner = LEARNER, mission = MISSION, actor = "verifier") => ledger.awardCredits(actor, learner, mission, PROOF);
const swap = (learner = LEARNER, actor = "redeemer") => ledger.requestSwap(actor, learner, ITEM, REQUEST);
const lastEvent = (name) => ledger.eventLog.filter((e) => e.name === name).at(-1);

// ---------------------------------------------------------------- authority

test("1. unauthorised award: a stranger and even the admin are refused", async () => {
  await rejects(award(LEARNER, MISSION, "stranger"), "AccessControlUnauthorizedAccount");
  await rejects(award(LEARNER, MISSION, "admin"), "AccessControlUnauthorizedAccount");
  assert.equal(await ledger.balanceOf(LEARNER), 0);
});

test("2. the ABI has no amount to pass: awardCredits takes learner, mission, proof — an extra amount is ignored", async () => {
  assert.equal(MemoryLedger.prototype.awardCredits.length, 4); // actor + (learnerHash, missionId, proofHash)
  await ledger.awardCredits("verifier", LEARNER, MISSION, PROOF, 999_999);
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
});

test("3. a passed mission awards exactly the configured amount and emits CreditsAwarded", async () => {
  const result = await award();
  assert.equal(result.amount, REWARD);
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
  const ev = lastEvent("CreditsAwarded");
  assert.deepEqual({ learnerHash: ev.args.learnerHash, missionId: ev.args.missionId, amount: ev.args.amount, proofHash: ev.args.proofHash }, { learnerHash: LEARNER, missionId: MISSION, amount: REWARD, proofHash: PROOF });
});

test("4. duplicate completion of the same mission is refused", async () => {
  await award();
  await rejects(award(), "MissionAlreadyCompleted");
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
});

test("5. a version bump lets the learner complete the revised mission again", async () => {
  await award();
  await ledger.configureMission("admin", MISSION, REWARD, 2, true);
  assert.equal(await ledger.missionCompleted(LEARNER, MISSION), false);
  await award();
  assert.equal(await ledger.balanceOf(LEARNER), REWARD * 2);
});

test("6. an inactive or unknown mission awards nothing", async () => {
  await ledger.configureMission("admin", MISSION, REWARD, 1, false);
  await rejects(award(), "MissionNotActive");
  await rejects(award(LEARNER, bytes32("mission:does-not-exist")), "MissionNotActive");
});

test("7. the admin cannot configure a reward above MAX_MISSION_REWARD", async () => {
  await rejects(ledger.configureMission("admin", MISSION, MAX_MISSION_REWARD + 1, 1, true), "RewardTooLarge");
  await ledger.configureMission("admin", MISSION, MAX_MISSION_REWARD, 1, true); // the ceiling itself is fine
  await rejects(ledger.configureMission("admin", MISSION, 0, 1, true), "InvalidAmount");
});

test("8. the lifetime cap is a ceiling on total credits, not a round count", async () => {
  // seven max-size missions = 14,000; an eighth of 2,000 would exceed 15,000
  for (let i = 0; i < 7; i++) {
    const id = bytes32(`mission:big-${i}`);
    await ledger.configureMission("admin", id, MAX_MISSION_REWARD, 1, true);
    await award(LEARNER, id);
  }
  const eighth = bytes32("mission:big-8");
  await ledger.configureMission("admin", eighth, MAX_MISSION_REWARD, 1, true);
  await rejects(award(LEARNER, eighth), "LifetimeCapExceeded");
  // ...but a 1,000-credit mission still fits under the ceiling
  const small = bytes32("mission:small");
  await ledger.configureMission("admin", small, 1000, 1, true);
  await award(LEARNER, small);
  assert.equal((await ledger.accountOf(LEARNER)).lifetimeAwarded, LIFETIME_CAP);
  // and the ceiling is per handle: another learner is unaffected
  await award(LEARNER_2, eighth);
});

test("9. a stranger cannot configure missions, the catalog, or pause", async () => {
  await rejects(ledger.configureMission("stranger", MISSION, REWARD, 1, true), "AccessControlUnauthorizedAccount");
  await rejects(ledger.configureCatalogItem("stranger", ITEM, PRODUCT, COST, STOCK, true), "AccessControlUnauthorizedAccount");
  await rejects(ledger.pause("verifier"), "AccessControlUnauthorizedAccount");
});

// ---------------------------------------------------------------- swaps

test("10. a short balance cannot open a swap", async () => {
  await rejects(swap(), "InsufficientCredits");
  await ledger.configureCatalogItem("admin", ITEM, PRODUCT, 200, STOCK, true);
  await award();
  await rejects(swap(), "InsufficientCredits");
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
});

test("11. empty stock cannot be swapped", async () => {
  await ledger.configureCatalogItem("admin", ITEM, PRODUCT, COST, 0, true);
  await award();
  await rejects(swap(), "OutOfStock");
});

test("12. an inactive or unknown item cannot be swapped", async () => {
  await award();
  await ledger.configureCatalogItem("admin", ITEM, PRODUCT, COST, STOCK, false);
  await rejects(swap(), "ItemNotAvailable");
  await rejects(ledger.requestSwap("redeemer", LEARNER, bytes32("item:nope"), REQUEST), "ItemNotAvailable");
});

test("13. requestSwap burns the credits first and takes one unit of stock", async () => {
  await award();
  const swapId = await swap();
  assert.equal(swapId, 0);
  assert.equal(await ledger.balanceOf(LEARNER), 0);
  assert.equal((await ledger.itemOf(ITEM)).inventory, STOCK - 1);
  assert.equal((await ledger.swapOf(0)).status, "Requested");
  const ev = lastEvent("SwapRequested");
  assert.equal(ev.args.cost, COST);
  assert.equal(ev.args.requestHash, REQUEST);
});

test("14. one balance cannot be swapped twice", async () => {
  await award();
  await swap();
  await rejects(swap(), "InsufficientCredits");
  assert.equal((await ledger.itemOf(ITEM)).inventory, STOCK - 1);
});

test("15. only the redeemer can open a swap", async () => {
  await award();
  await rejects(swap(LEARNER, "verifier"), "AccessControlUnauthorizedAccount");
  await rejects(swap(LEARNER, "fulfiller"), "AccessControlUnauthorizedAccount");
  await rejects(swap(LEARNER, "admin"), "AccessControlUnauthorizedAccount");
});

test("16. a swap settles once, with only a commitment on the ledger", async () => {
  await award();
  const id = await swap();
  await ledger.settleSwap("fulfiller", id, COMMITMENT);
  const s = await ledger.swapOf(id);
  assert.equal(s.status, "Settled");
  assert.equal(s.voucherCommitment, COMMITMENT);
  await rejects(ledger.settleSwap("fulfiller", id, COMMITMENT), "InvalidSwap");
  await rejects(ledger.settleSwap("fulfiller", 99, COMMITMENT), "InvalidSwap");
});

test("17. the redeemer key is refused at settleSwap", async () => {
  await award();
  const id = await swap();
  await rejects(ledger.settleSwap("redeemer", id, COMMITMENT), "AccessControlUnauthorizedAccount");
  await rejects(ledger.settleSwap("verifier", id, COMMITMENT), "AccessControlUnauthorizedAccount");
  assert.equal((await ledger.swapOf(id)).status, "Requested");
});

test("18. cancel restores credits and stock exactly, and records the reason", async () => {
  await award();
  const id = await swap();
  await ledger.cancelSwap("fulfiller", id, reasonBytes32("provider:timeout"));
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
  assert.equal((await ledger.itemOf(ITEM)).inventory, STOCK);
  assert.equal((await ledger.swapOf(id)).status, "Cancelled");
  assert.equal(reasonFromBytes32(lastEvent("SwapCancelled").args.reason), "provider:timeout");
});

test("19. a refund is exact even if the catalog price changed meanwhile", async () => {
  await award();
  const id = await swap(); // cost 100 recorded on the swap
  await ledger.configureCatalogItem("admin", ITEM, PRODUCT, 150, STOCK - 1, true);
  await ledger.cancelSwap("fulfiller", id, reasonBytes32("test"));
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
  assert.equal((await ledger.itemOf(ITEM)).inventory, STOCK);
});

test("20. a settled or cancelled swap cannot be cancelled, and the verifier cannot cancel at all", async () => {
  await award();
  const id = await swap();
  await rejects(ledger.cancelSwap("verifier", id, reasonBytes32("x")), "AccessControlUnauthorizedAccount");
  await rejects(ledger.cancelSwap("redeemer", id, reasonBytes32("x")), "AccessControlUnauthorizedAccount");
  await ledger.settleSwap("fulfiller", id, COMMITMENT);
  await rejects(ledger.cancelSwap("fulfiller", id, reasonBytes32("x")), "InvalidSwap");
  await rejects(ledger.cancelSwap("admin", id, reasonBytes32("x")), "InvalidSwap");
});

test("21. the admin may cancel a stuck swap (refund path without the fulfiller key)", async () => {
  await award();
  const id = await swap();
  await ledger.cancelSwap("admin", id, reasonBytes32("admin:stuck"));
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
});

test("21b. a refund after expiry remains usable and expires only the unrelated balance", async () => {
  await award(LEARNER, MISSION);
  await award(LEARNER, MISSION_2);
  const id = await swap(); // 100 remains in the account, 100 is in the swap
  clock += CREDIT_TTL;
  await ledger.cancelSwap("fulfiller", id, reasonBytes32("late:refund"));
  assert.equal(await ledger.balanceOf(LEARNER), COST);
  assert.equal((await ledger.accountOf(LEARNER)).expiresAt, clock + REFUND_GRACE_PERIOD);
  const stats = await ledger.stats();
  assert.deepEqual(
    { awarded: stats.awarded, outstanding: stats.outstanding, inSwap: stats.inSwap, expired: stats.expired },
    { awarded: 200, outstanding: 100, inSwap: 0, expired: 100 }
  );
});

// ---------------------------------------------------------------- expiry

test("22. credits expire 365 days after the last award", async () => {
  await award();
  clock += CREDIT_TTL - 1;
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
  clock += 1;
  assert.equal(await ledger.balanceOf(LEARNER), 0);
  await rejects(swap(), "InsufficientCredits"); // and the expired balance cannot be spent
});

test("23. sweepExpired is permissionless — anyone can run it, nobody chooses the outcome", async () => {
  await award();
  await rejects(ledger.sweepExpired(LEARNER), "NothingToSweep"); // not yet
  clock += CREDIT_TTL;
  await ledger.sweepExpired(LEARNER); // no actor: a stranger, a bot, anyone
  const ev = lastEvent("CreditsExpired");
  assert.equal(ev.args.amount, REWARD);
  assert.equal((await ledger.stats()).expired, REWARD);
  await rejects(ledger.sweepExpired(LEARNER), "NothingToSweep");
});

test("24. a new award extends the clock for the whole balance", async () => {
  await award();
  const first = (await ledger.accountOf(LEARNER)).expiresAt;
  clock += 100 * 86400;
  await award(LEARNER, MISSION_2);
  const second = (await ledger.accountOf(LEARNER)).expiresAt;
  assert.equal(second - first, 100 * 86400);
  clock = first + 1; // past the first deadline, inside the second
  assert.equal(await ledger.balanceOf(LEARNER), REWARD * 2);
});

// ---------------------------------------------------------------- pause

test("25. pause blocks earning and swapping", async () => {
  await award();
  await ledger.pause("admin");
  assert.equal(await ledger.paused(), true);
  await rejects(award(LEARNER, MISSION_2), "EnforcedPause");
  await rejects(swap(), "EnforcedPause");
  await ledger.unpause("admin");
  await award(LEARNER, MISSION_2);
  assert.equal(await ledger.balanceOf(LEARNER), REWARD * 2);
});

test("26. pause still allows a refund: cancelSwap works while paused", async () => {
  await award();
  const id = await swap();
  await ledger.pause("admin");
  await rejects(ledger.settleSwap("fulfiller", id, COMMITMENT), "EnforcedPause");
  await ledger.cancelSwap("fulfiller", id, reasonBytes32("paused:refund"));
  assert.equal(await ledger.balanceOf(LEARNER), REWARD);
  assert.equal((await ledger.itemOf(ITEM)).inventory, STOCK);
});

// ---------------------------------------------------------------- conservation

test("27. conservation: awarded == outstanding + in-swap + swapped + expired, through every path", async () => {
  const check = async () => {
    const s = await ledger.stats();
    assert.equal(s.awarded, s.outstanding + s.inSwap + s.swapped + s.expired, JSON.stringify(s));
    return s;
  };
  await award(LEARNER);
  await award(LEARNER, MISSION_2);
  await award(LEARNER_2);
  await check();
  const a = await swap(LEARNER); // in swap
  await check();
  await ledger.settleSwap("fulfiller", a, COMMITMENT); // swapped
  await check();
  const b = await swap(LEARNER);
  await ledger.cancelSwap("fulfiller", b, reasonBytes32("x")); // back to outstanding
  await check();
  clock += CREDIT_TTL;
  await ledger.sweepExpired(LEARNER_2); // expired
  const s = await check();
  assert.deepEqual({ awarded: s.awarded, swapped: s.swapped, expired: s.expired, outstanding: s.outstanding, inSwap: s.inSwap }, { awarded: 300, swapped: 100, expired: 100, outstanding: 100, inSwap: 0 });
});

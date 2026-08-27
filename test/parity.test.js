// Two ledgers, one script, one transcript.
//
// LanguageCredits.sol and MemoryLedger implement the same rules twice. Two
// implementations of the same rules drift: someone fixes a refund path in
// Solidity and the JavaScript mirror keeps the old behaviour, and the demo
// then shows something the contract would never have done.
//
// This test refuses to let that happen quietly. It drives the *identical*
// sequence of calls through both ledgers and compares the full transcript —
// balances, lifetime totals, stock, swap status, the conservation totals and
// the revert names — step by step.
//
// It needs a chain, so it skips itself unless one is there:
//
//   cd contracts && npx hardhat node                                  # terminal 1
//   cd contracts && npx hardhat run scripts/deploy.js --network localhost
//   npm run test:parity                                               # terminal 2
//
// Skipping is loud (the reason is printed), never silent.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { MemoryLedger, ChainLedger, verifyLedger, ROLES, CREDIT_TTL } = require("../server/ledger");
const assessment = require("../server/assessment");
const catalog = require("../server/catalog");
const { hashParts } = require("../server/ids");

const DEPLOYMENT = path.join(__dirname, "..", "shared", "deployment.json");

let chain = null;
let skipReason = null;

before(async () => {
  if (!fs.existsSync(DEPLOYMENT)) {
    skipReason = "no shared/deployment.json — deploy to a local chain first";
    return;
  }
  try {
    const candidate = new ChainLedger();
    // The same bounded probe the service uses, so `npm test` can never hang
    // waiting for an RPC endpoint that is not there.
    const probe = await verifyLedger(candidate, { LEDGER: "" }, 3000);
    if (probe.fellBack) {
      chain = null;
      skipReason = `chain unreachable: ${probe.reason}`;
    } else {
      chain = candidate;
    }
  } catch (err) {
    chain = null;
    skipReason = `chain unavailable: ${String(err?.message ?? err).slice(0, 120)}`;
  }
});

after(() => {
  try {
    chain?.provider?.destroy?.(); // let the test process exit
  } catch {
    /* nothing left to close */
  }
});

/** The same seed deploy.js writes to the chain. */
async function seedMemory(ledger) {
  for (const [role, actor] of [
    [ROLES.VERIFIER_ROLE, "verifier"],
    [ROLES.REDEEMER_ROLE, "redeemer"],
    [ROLES.FULFILLER_ROLE, "fulfiller"],
  ]) {
    await ledger.grantRole("admin", role, actor);
  }
  for (const m of assessment.MISSIONS) await ledger.configureMission("admin", m.missionId, m.reward, m.version, true);
  for (const item of catalog.all()) {
    await ledger.configureCatalogItem("admin", item.itemId, hashParts("product", item.productCode), item.cost, item.inventory, true);
  }
}

const M0 = assessment.MISSIONS[0].missionId;
const M1 = assessment.MISSIONS[1].missionId;
const ITEM = catalog.all()[0].itemId;
const proof = (n) => hashParts("parity-proof", String(n));

/**
 * The script. Every step is (label, fn) where fn may throw a LedgerError —
 * the revert name is part of what must match, not a reason to stop.
 */
const SCRIPT = [
  ["award the first mission", (l, c) => l.awardCredits("verifier", c.learner, M0, proof(1))],
  ["award it a second time", (l, c) => l.awardCredits("verifier", c.learner, M0, proof(2))],
  ["open a swap", async (l, c) => (c.swapA = await l.requestSwap("redeemer", c.learner, ITEM, hashParts("parity-req", c.learner, "a")))],
  ["settle it with a commitment", (l, c) => l.settleSwap("fulfiller", c.swapA, hashParts("parity-voucher", "a"))],
  ["open a second swap with nothing left", (l, c) => l.requestSwap("redeemer", c.learner, ITEM, hashParts("parity-req", c.learner, "b"))],
  ["award the second mission", (l, c) => l.awardCredits("verifier", c.learner, M1, proof(3))],
  ["open a swap to cancel", async (l, c) => (c.swapB = await l.requestSwap("redeemer", c.learner, ITEM, hashParts("parity-req", c.learner, "c")))],
  ["cancel it", (l, c) => l.cancelSwap("fulfiller", c.swapB, hashParts("parity-reason", "provider:timeout"))],
  ["settle the cancelled swap anyway", (l, c) => l.settleSwap("fulfiller", c.swapB, hashParts("parity-voucher", "b"))],
  ["spend the refunded credits", async (l, c) => (c.swapC = await l.requestSwap("redeemer", c.learner, ITEM, hashParts("parity-req", c.learner, "d")))],
  ["let a stranger award credits", (l, c) => l.awardCredits("stranger", c.learner, M1, proof(4))],
  ["let the redeemer settle", (l, c) => l.settleSwap("redeemer", c.swapC, hashParts("parity-voucher", "c"))],
  ["settle it with the right key", (l, c) => l.settleSwap("fulfiller", c.swapC, hashParts("parity-voucher", "c"))],
];

/** What the two ledgers must agree on after every single step. */
async function observe(ledger, ctx, label, error) {
  const account = await ledger.accountOf(ctx.learner);
  const item = await ledger.itemOf(ITEM);
  const totals = await ledger.stats();
  const swap = ctx.swapC ?? ctx.swapB ?? ctx.swapA;
  return {
    step: label,
    revert: error ? error.name : null,
    balance: await ledger.balanceOf(ctx.learner),
    lifetimeAwarded: account.lifetimeAwarded,
    // block timestamps and Date.now() differ by seconds; the TTL must not
    expiresInDays: account.expiresAt ? Math.round((account.expiresAt - ctx.startedAt) / 86400) : 0,
    stockUsed: ctx.stockAtStart - item.inventory,
    lastSwap: swap === undefined ? null : (await ledger.swapOf(swap)).status,
    swapsOpened: (await ledger.swapCount()) - ctx.swapsAtStart,
    awardedDelta: totals.awarded - ctx.totalsAtStart.awarded,
    outstandingDelta: totals.outstanding - ctx.totalsAtStart.outstanding,
    inSwapDelta: totals.inSwap - ctx.totalsAtStart.inSwap,
    swappedDelta: totals.swapped - ctx.totalsAtStart.swapped,
    expiredDelta: totals.expired - ctx.totalsAtStart.expired,
  };
}

async function run(ledger, learner) {
  const totals = await ledger.stats();
  const item = await ledger.itemOf(ITEM);
  const ctx = {
    learner,
    startedAt: Math.floor(Date.now() / 1000),
    stockAtStart: item.inventory,
    swapsAtStart: await ledger.swapCount(),
    totalsAtStart: { ...totals },
  };
  const transcript = [];
  for (const [label, fn] of SCRIPT) {
    let error = null;
    try {
      await fn(ledger, ctx);
    } catch (err) {
      error = err;
    }
    transcript.push(await observe(ledger, ctx, label, error));
  }
  return transcript;
}

test("the contract and the JavaScript mirror produce the same transcript", async (t) => {
  if (!chain) return t.skip(skipReason);

  // A fresh learner on each side: the chain keeps state between runs, the
  // mirror does not, so the comparison must not depend on either being empty.
  const learner = "0x" + crypto.randomBytes(32).toString("hex");
  const memory = new MemoryLedger();
  await seedMemory(memory);

  const fromChain = await run(chain, learner);
  const fromMemory = await run(memory, learner);

  for (let i = 0; i < SCRIPT.length; i += 1) {
    assert.deepEqual(
      fromMemory[i],
      fromChain[i],
      `the ledgers disagree at step ${i + 1}, "${SCRIPT[i][0]}"\n` +
        `  mirror: ${JSON.stringify(fromMemory[i])}\n` +
        `  chain:  ${JSON.stringify(fromChain[i])}`
    );
  }

  // The script has to have actually exercised something.
  const last = fromChain.at(-1);
  assert.equal(last.lastSwap, "Settled");
  assert.equal(last.expiresInDays, CREDIT_TTL / 86400);
  assert.ok(fromChain.some((s) => s.revert === "MissionAlreadyCompleted"));
  assert.ok(fromChain.some((s) => s.revert === "InsufficientCredits"));
  assert.ok(fromChain.some((s) => s.revert === "InvalidSwap"));
  assert.ok(fromChain.some((s) => s.revert === "AccessControlUnauthorizedAccount"));
});

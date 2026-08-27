const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// The Solidity suite mirrors test/ledger.test.js at the repo root. Keep the
// two in step: if you change one, change the other and run both.

const id = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

const LEARNER = id("learner:mina");
const LEARNER_2 = id("learner:jun");
const MISSION = id("mission:library");
const MISSION_2 = id("mission:pharmacy");
const ITEM = id("item:tim-hortons-5");
const PRODUCT = id("product:TIMHORTONS-CA-0500");
const PROOF = id("proof:1");
const REQUEST = id("request:1");
const COMMITMENT = id("voucher:1");
const REASON = ethers.encodeBytes32String("provider:timeout");

const REWARD = 100n;
const COST = 100n;
const STOCK = 3n;
const TTL = 365n * 24n * 60n * 60n;
const REFUND_GRACE = 30n * 24n * 60n * 60n;

const advance = async (seconds) => {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine");
};

describe("LanguageCredits", function () {
  let c;
  let admin, verifier, redeemer, fulfiller, stranger;

  beforeEach(async function () {
    [admin, verifier, redeemer, fulfiller, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("LanguageCredits", admin);
    c = await factory.deploy(admin.address);
    await c.grantRole(await c.VERIFIER_ROLE(), verifier.address);
    await c.grantRole(await c.REDEEMER_ROLE(), redeemer.address);
    await c.grantRole(await c.FULFILLER_ROLE(), fulfiller.address);
    await c.configureMission(MISSION, REWARD, 1, true);
    await c.configureMission(MISSION_2, REWARD, 1, true);
    await c.configureCatalogItem(ITEM, PRODUCT, COST, STOCK, true);
  });

  const award = (learner = LEARNER, mission = MISSION, signer = verifier) => c.connect(signer).awardCredits(learner, mission, PROOF);
  const swap = (learner = LEARNER, signer = redeemer) => c.connect(signer).requestSwap(learner, ITEM, REQUEST);

  describe("the ABI", function () {
    it("has no transfer, approve or permit — this is not an ERC-20 with transfers switched off", async function () {
      const names = c.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const forbidden of ["transfer", "transferFrom", "approve", "permit", "allowance", "safeTransferFrom", "setApprovalForAll"]) {
        expect(names, forbidden).to.not.include(forbidden);
      }
    });

    it("has no amount parameter on awardCredits", async function () {
      const fn = c.interface.getFunction("awardCredits");
      expect(fn.inputs.map((i) => `${i.type} ${i.name}`)).to.deep.equal(["bytes32 learnerHash", "bytes32 missionId", "bytes32 proofHash"]);
    });

    it("emits only bytes32, uint and bool fields — nothing can carry a name", async function () {
      for (const ev of c.interface.fragments.filter((f) => f.type === "event")) {
        for (const input of ev.inputs) {
          expect(input.type, `${ev.name}.${input.name}`).to.match(/^(bytes32|uint\d+|bool|address)$/);
          expect(input.type, `${ev.name}.${input.name}`).to.not.equal("string");
        }
      }
    });

    it("exposes the limits the admin cannot raise as constants", async function () {
      expect(await c.MAX_MISSION_REWARD()).to.equal(2000n);
      expect(await c.LIFETIME_CAP()).to.equal(15000n);
      expect(await c.CREDIT_TTL()).to.equal(TTL);
    });
  });

  describe("awarding", function () {
    it("refuses a stranger and the admin", async function () {
      await expect(award(LEARNER, MISSION, stranger)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await expect(award(LEARNER, MISSION, admin)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });

    it("awards the configured amount and emits CreditsAwarded", async function () {
      await expect(award()).to.emit(c, "CreditsAwarded").withArgs(LEARNER, MISSION, 1, REWARD, PROOF, (v) => v > 0n);
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD);
    });

    it("refuses duplicate completion, allows it again after a version bump", async function () {
      await award();
      await expect(award()).to.be.revertedWithCustomError(c, "MissionAlreadyCompleted");
      await c.configureMission(MISSION, REWARD, 2, true);
      expect(await c.missionCompleted(LEARNER, MISSION)).to.equal(false);
      await award();
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD * 2n);
    });

    it("refuses an inactive mission", async function () {
      await c.configureMission(MISSION, REWARD, 1, false);
      await expect(award()).to.be.revertedWithCustomError(c, "MissionNotActive");
    });

    it("refuses a reward above MAX_MISSION_REWARD even from the admin", async function () {
      await expect(c.configureMission(MISSION, 2001n, 1, true)).to.be.revertedWithCustomError(c, "RewardTooLarge");
      await expect(c.configureMission(MISSION, 0n, 1, true)).to.be.revertedWithCustomError(c, "InvalidAmount");
    });

    it("applies the lifetime cap as a ceiling, not a round count", async function () {
      for (let i = 0; i < 7; i++) {
        const m = id(`mission:big-${i}`);
        await c.configureMission(m, 2000n, 1, true);
        await award(LEARNER, m);
      }
      const eighth = id("mission:big-8");
      await c.configureMission(eighth, 2000n, 1, true);
      await expect(award(LEARNER, eighth)).to.be.revertedWithCustomError(c, "LifetimeCapExceeded");
      const small = id("mission:small");
      await c.configureMission(small, 1000n, 1, true);
      await award(LEARNER, small);
      expect((await c.accountOf(LEARNER)).lifetimeAwarded).to.equal(15000n);
      await award(LEARNER_2, eighth);
    });
  });

  describe("swaps", function () {
    it("refuses a short balance, empty stock and an inactive item", async function () {
      await expect(swap()).to.be.revertedWithCustomError(c, "InsufficientCredits");
      await award();
      await c.configureCatalogItem(ITEM, PRODUCT, COST, 0n, true);
      await expect(swap()).to.be.revertedWithCustomError(c, "OutOfStock");
      await c.configureCatalogItem(ITEM, PRODUCT, COST, STOCK, false);
      await expect(swap()).to.be.revertedWithCustomError(c, "ItemNotAvailable");
    });

    it("burns first and takes one unit of stock; one balance cannot be swapped twice", async function () {
      await award();
      await expect(swap()).to.emit(c, "SwapRequested").withArgs(0, LEARNER, ITEM, COST, REQUEST);
      expect(await c.balanceOf(LEARNER)).to.equal(0n);
      expect((await c.itemOf(ITEM)).inventory).to.equal(STOCK - 1n);
      await expect(swap()).to.be.revertedWithCustomError(c, "InsufficientCredits");
    });

    it("only the redeemer can open a swap", async function () {
      await award();
      for (const s of [verifier, fulfiller, admin, stranger]) {
        await expect(swap(LEARNER, s)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      }
    });

    it("settles once, with a commitment only", async function () {
      await award();
      await swap();
      await expect(c.connect(fulfiller).settleSwap(0, COMMITMENT)).to.emit(c, "SwapSettled").withArgs(0, COMMITMENT);
      expect((await c.swapOf(0)).status).to.equal(2n);
      await expect(c.connect(fulfiller).settleSwap(0, COMMITMENT)).to.be.revertedWithCustomError(c, "InvalidSwap");
      await expect(c.connect(fulfiller).settleSwap(9, COMMITMENT)).to.be.revertedWithCustomError(c, "InvalidSwap");
    });

    it("refuses the redeemer key at settleSwap", async function () {
      await award();
      await swap();
      await expect(c.connect(redeemer).settleSwap(0, COMMITMENT)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await expect(c.connect(verifier).settleSwap(0, COMMITMENT)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });

    it("cancel restores credits and stock exactly, and is exact even if the price changed", async function () {
      await award();
      await swap();
      await c.configureCatalogItem(ITEM, PRODUCT, 150n, STOCK - 1n, true);
      await expect(c.connect(fulfiller).cancelSwap(0, REASON)).to.emit(c, "SwapCancelled").withArgs(0, REASON);
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD);
      expect((await c.itemOf(ITEM)).inventory).to.equal(STOCK);
      await expect(c.connect(fulfiller).cancelSwap(0, REASON)).to.be.revertedWithCustomError(c, "InvalidSwap");
    });

    it("lets the admin cancel but not the verifier or redeemer", async function () {
      await award();
      await swap();
      await expect(c.connect(verifier).cancelSwap(0, REASON)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await expect(c.connect(redeemer).cancelSwap(0, REASON)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await c.connect(admin).cancelSwap(0, REASON);
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD);
    });

    it("keeps a refund usable after account expiry and expires only the unrelated balance", async function () {
      await award(LEARNER, MISSION);
      await award(LEARNER, MISSION_2);
      await swap();
      await advance(TTL);
      const receipt = await (await c.connect(fulfiller).cancelSwap(0, REASON)).wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const account = await c.accountOf(LEARNER);
      expect(await c.balanceOf(LEARNER)).to.equal(COST);
      expect(account.expiresAt).to.equal(BigInt(block.timestamp) + REFUND_GRACE);
      expect(await c.totalOutstanding()).to.equal(COST);
      expect(await c.totalExpired()).to.equal(REWARD);
    });
  });

  describe("expiry", function () {
    it("expires the balance 365 days after the last award, and sweeping is permissionless", async function () {
      await award();
      await expect(c.connect(stranger).sweepExpired(LEARNER)).to.be.revertedWithCustomError(c, "NothingToSweep");
      await advance(TTL);
      expect(await c.balanceOf(LEARNER)).to.equal(0n);
      await expect(swap()).to.be.revertedWithCustomError(c, "InsufficientCredits");
      await expect(c.connect(stranger).sweepExpired(LEARNER)).to.emit(c, "CreditsExpired").withArgs(LEARNER, REWARD);
      expect(await c.totalExpired()).to.equal(REWARD);
    });

    it("extends the clock with every new award", async function () {
      await award();
      const first = (await c.accountOf(LEARNER)).expiresAt;
      await advance(100n * 86400n);
      await award(LEARNER, MISSION_2);
      const second = (await c.accountOf(LEARNER)).expiresAt;
      expect(second - first).to.be.gte(100n * 86400n);
      await advance(TTL - 100n * 86400n + 1n); // past the first deadline, inside the second
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD * 2n);
    });
  });

  describe("pause", function () {
    it("blocks earning and swapping but still allows a refund", async function () {
      await award();
      await swap();
      await c.pause();
      await expect(award(LEARNER, MISSION_2)).to.be.revertedWithCustomError(c, "EnforcedPause");
      await expect(swap()).to.be.revertedWithCustomError(c, "EnforcedPause");
      await expect(c.connect(fulfiller).settleSwap(0, COMMITMENT)).to.be.revertedWithCustomError(c, "EnforcedPause");
      await c.connect(fulfiller).cancelSwap(0, REASON); // refund does not wait for un-pause
      expect(await c.balanceOf(LEARNER)).to.equal(REWARD);
      await c.unpause();
      await award(LEARNER, MISSION_2);
    });

    it("only the admin can pause", async function () {
      await expect(c.connect(verifier).pause()).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });
  });

  describe("conservation", function () {
    it("awarded == outstanding + in-swap + swapped + expired through every path", async function () {
      const check = async () => {
        const [a, o, i, s, e] = await Promise.all([c.totalAwarded(), c.totalOutstanding(), c.totalInSwap(), c.totalSwapped(), c.totalExpired()]);
        expect(a).to.equal(o + i + s + e);
        return { a, o, i, s, e };
      };
      await award(LEARNER);
      await award(LEARNER, MISSION_2);
      await award(LEARNER_2);
      await check();
      await swap(LEARNER);
      await check();
      await c.connect(fulfiller).settleSwap(0, COMMITMENT);
      await check();
      await swap(LEARNER);
      await c.connect(fulfiller).cancelSwap(1, REASON);
      await check();
      await advance(TTL);
      await c.connect(stranger).sweepExpired(LEARNER_2);
      const t = await check();
      expect(t).to.deep.equal({ a: 300n, o: 100n, i: 0n, s: 100n, e: 100n });
    });
  });
});

// The contract's rules, mirrored in JavaScript.
//
// MemoryLedger implements every rule LanguageCredits.sol does — same
// function names, same error names, same events — and the demo uses it
// unless LEDGER=chain says otherwise. A dead RPC endpoint can therefore
// never be the thing that stops the pitch, and the ledger tests run in
// well under a second with no toolchain.
//
// ChainLedger wraps the deployed contract behind the same interface.
// Keep the two in step: if you change one, change the other and run both
// suites (npm test, and npx hardhat test in contracts/).
"use strict";

const path = require("path");
const fs = require("fs");

const ROLES = {
  DEFAULT_ADMIN_ROLE: "DEFAULT_ADMIN_ROLE",
  ADMIN_ROLE: "ADMIN_ROLE",
  VERIFIER_ROLE: "VERIFIER_ROLE",
  REDEEMER_ROLE: "REDEEMER_ROLE",
  FULFILLER_ROLE: "FULFILLER_ROLE",
};

// Limits the admin cannot raise — identical to the Solidity constants.
const MAX_MISSION_REWARD = 2000;
const LIFETIME_CAP = 15000;
const CREDIT_TTL = 365 * 24 * 60 * 60;

const SWAP_STATUS = ["None", "Requested", "Settled", "Cancelled"];

/** A revert. `name` is the Solidity custom error name; `args` its fields. */
class LedgerError extends Error {
  constructor(name, args = {}) {
    super(`${name}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(", ")})`);
    this.name = name;
    this.args = args;
  }
}

const ZERO32 = "0x" + "0".repeat(64);

// ---------------------------------------------------------------- memory

class MemoryLedger {
  constructor({ admin = "admin", now } = {}) {
    this.mode = "memory";
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
    this.roles = new Map(Object.values(ROLES).map((r) => [r, new Set()]));
    this.roles.get(ROLES.DEFAULT_ADMIN_ROLE).add(admin);
    this.roles.get(ROLES.ADMIN_ROLE).add(admin);
    this.roleAdmin = {
      [ROLES.ADMIN_ROLE]: ROLES.DEFAULT_ADMIN_ROLE,
      [ROLES.VERIFIER_ROLE]: ROLES.ADMIN_ROLE,
      [ROLES.REDEEMER_ROLE]: ROLES.ADMIN_ROLE,
      [ROLES.FULFILLER_ROLE]: ROLES.ADMIN_ROLE,
    };
    this.missions = new Map();
    this.items = new Map();
    this.accounts = new Map();
    this.completed = new Set(); // `${learner}|${mission}|${version}`
    this.swaps = [];
    this._paused = false;
    this.totals = { awarded: 0, outstanding: 0, inSwap: 0, swapped: 0, expired: 0 };
    this.eventLog = [];
    this.listeners = new Set();
  }

  // -- roles ------------------------------------------------------------

  _require(actor, role) {
    if (!this.roles.get(role)?.has(actor)) {
      throw new LedgerError("AccessControlUnauthorizedAccount", { account: actor, neededRole: role });
    }
  }

  _whenNotPaused() {
    if (this._paused) throw new LedgerError("EnforcedPause");
  }

  async hasRole(role, account) {
    return Boolean(this.roles.get(role)?.has(account));
  }

  async grantRole(actor, role, account) {
    this._require(actor, this.roleAdmin[role] ?? ROLES.DEFAULT_ADMIN_ROLE);
    this.roles.get(role).add(account);
    this._emit("RoleGranted", { role, account, sender: actor });
  }

  async revokeRole(actor, role, account) {
    this._require(actor, this.roleAdmin[role] ?? ROLES.DEFAULT_ADMIN_ROLE);
    this.roles.get(role).delete(account);
    this._emit("RoleRevoked", { role, account, sender: actor });
  }

  // -- admin ------------------------------------------------------------

  async configureMission(actor, missionId, reward, version, active) {
    this._require(actor, ROLES.ADMIN_ROLE);
    reward = Number(reward);
    version = Number(version);
    if (!(reward > 0)) throw new LedgerError("InvalidAmount");
    if (reward > MAX_MISSION_REWARD) throw new LedgerError("RewardTooLarge", { reward, max: MAX_MISSION_REWARD });
    this.missions.set(missionId, { reward, version, active: Boolean(active), exists: true });
    this._emit("MissionConfigured", { missionId, reward, version, active: Boolean(active) });
  }

  async configureCatalogItem(actor, itemId, productCode, cost, inventory, active) {
    this._require(actor, ROLES.ADMIN_ROLE);
    cost = Number(cost);
    inventory = Number(inventory);
    if (!(cost > 0)) throw new LedgerError("InvalidAmount");
    this.items.set(itemId, { productCode, cost, inventory, active: Boolean(active), exists: true });
    this._emit("CatalogItemConfigured", { itemId, productCode, cost, inventory, active: Boolean(active) });
  }

  async pause(actor) {
    this._require(actor, ROLES.ADMIN_ROLE);
    if (this._paused) throw new LedgerError("EnforcedPause");
    this._paused = true;
    this._emit("Paused", { account: actor });
  }

  async unpause(actor) {
    this._require(actor, ROLES.ADMIN_ROLE);
    if (!this._paused) throw new LedgerError("ExpectedPause");
    this._paused = false;
    this._emit("Unpaused", { account: actor });
  }

  async paused() {
    return this._paused;
  }

  // -- award ------------------------------------------------------------

  _account(learnerHash) {
    let a = this.accounts.get(learnerHash);
    if (!a) {
      a = { balance: 0, lifetimeAwarded: 0, expiresAt: 0 };
      this.accounts.set(learnerHash, a);
    }
    return a;
  }

  _isExpired(a) {
    return a.expiresAt !== 0 && this.now() >= a.expiresAt;
  }

  _expire(learnerHash, a) {
    const amount = a.balance;
    a.balance = 0;
    this.totals.outstanding -= amount;
    this.totals.expired += amount;
    this._emit("CreditsExpired", { learnerHash, amount });
  }

  _sweepIfExpired(learnerHash) {
    const a = this._account(learnerHash);
    if (a.balance !== 0 && this._isExpired(a)) this._expire(learnerHash, a);
  }

  async awardCredits(actor, learnerHash, missionId, proofHash) {
    this._require(actor, ROLES.VERIFIER_ROLE);
    this._whenNotPaused();
    const mission = this.missions.get(missionId);
    if (!mission || !mission.active) throw new LedgerError("MissionNotActive", { missionId });
    const key = `${learnerHash}|${missionId}|${mission.version}`;
    if (this.completed.has(key)) {
      throw new LedgerError("MissionAlreadyCompleted", { learnerHash, missionId, version: mission.version });
    }
    this._sweepIfExpired(learnerHash);
    const a = this._account(learnerHash);
    if (a.lifetimeAwarded + mission.reward > LIFETIME_CAP) {
      throw new LedgerError("LifetimeCapExceeded", { learnerHash, lifetimeAwarded: a.lifetimeAwarded, reward: mission.reward });
    }
    this.completed.add(key);
    a.balance += mission.reward;
    a.lifetimeAwarded += mission.reward;
    a.expiresAt = this.now() + CREDIT_TTL;
    this.totals.awarded += mission.reward;
    this.totals.outstanding += mission.reward;
    this._emit("CreditsAwarded", { learnerHash, missionId, version: mission.version, amount: mission.reward, proofHash, expiresAt: a.expiresAt });
    return { amount: mission.reward, version: mission.version, expiresAt: a.expiresAt };
  }

  async sweepExpired(learnerHash) {
    const a = this._account(learnerHash);
    if (a.balance === 0 || !this._isExpired(a)) throw new LedgerError("NothingToSweep", { learnerHash });
    this._expire(learnerHash, a);
  }

  // -- swap -------------------------------------------------------------

  async requestSwap(actor, learnerHash, itemId, requestHash) {
    this._require(actor, ROLES.REDEEMER_ROLE);
    this._whenNotPaused();
    const item = this.items.get(itemId);
    if (!item || !item.active) throw new LedgerError("ItemNotAvailable", { itemId });
    if (item.inventory === 0) throw new LedgerError("OutOfStock", { itemId });
    this._sweepIfExpired(learnerHash);
    const a = this._account(learnerHash);
    if (a.balance < item.cost) throw new LedgerError("InsufficientCredits", { learnerHash, balance: a.balance, cost: item.cost });
    a.balance -= item.cost;
    item.inventory -= 1;
    this.totals.outstanding -= item.cost;
    this.totals.inSwap += item.cost;
    const swapId = this.swaps.length;
    this.swaps.push({ swapId, learnerHash, itemId, requestHash, voucherCommitment: ZERO32, cost: item.cost, status: "Requested" });
    this._emit("SwapRequested", { swapId, learnerHash, itemId, cost: item.cost, requestHash });
    return swapId;
  }

  _swap(swapId) {
    const swap = this.swaps[Number(swapId)];
    if (!swap) throw new LedgerError("InvalidSwap", { swapId });
    return swap;
  }

  async settleSwap(actor, swapId, voucherCommitment) {
    this._require(actor, ROLES.FULFILLER_ROLE);
    this._whenNotPaused();
    const swap = this._swap(swapId);
    if (swap.status !== "Requested") throw new LedgerError("InvalidSwap", { swapId });
    swap.status = "Settled";
    swap.voucherCommitment = voucherCommitment;
    this.totals.inSwap -= swap.cost;
    this.totals.swapped += swap.cost;
    this._emit("SwapSettled", { swapId, voucherCommitment });
  }

  /** Deliberately not blocked by pause: refunds never wait for an un-pause. */
  async cancelSwap(actor, swapId, reason) {
    const fulfiller = this.roles.get(ROLES.FULFILLER_ROLE).has(actor);
    const admin = this.roles.get(ROLES.ADMIN_ROLE).has(actor);
    if (!fulfiller && !admin) {
      throw new LedgerError("AccessControlUnauthorizedAccount", { account: actor, neededRole: ROLES.FULFILLER_ROLE });
    }
    const swap = this._swap(swapId);
    if (swap.status !== "Requested") throw new LedgerError("InvalidSwap", { swapId });
    swap.status = "Cancelled";
    this._account(swap.learnerHash).balance += swap.cost;
    this.items.get(swap.itemId).inventory += 1;
    this.totals.inSwap -= swap.cost;
    this.totals.outstanding += swap.cost;
    this._emit("SwapCancelled", { swapId, reason });
  }

  // -- views ------------------------------------------------------------

  async balanceOf(learnerHash) {
    const a = this.accounts.get(learnerHash);
    if (!a || this._isExpired(a)) return 0;
    return a.balance;
  }

  async accountOf(learnerHash) {
    const a = this.accounts.get(learnerHash) ?? { balance: 0, lifetimeAwarded: 0, expiresAt: 0 };
    return { ...a };
  }

  async missionCompleted(learnerHash, missionId) {
    const mission = this.missions.get(missionId);
    if (!mission) return false;
    return this.completed.has(`${learnerHash}|${missionId}|${mission.version}`);
  }

  async missionOf(missionId) {
    const m = this.missions.get(missionId);
    return m ? { ...m } : { reward: 0, version: 0, active: false, exists: false };
  }

  async itemOf(itemId) {
    const i = this.items.get(itemId);
    return i ? { ...i } : { productCode: ZERO32, cost: 0, inventory: 0, active: false, exists: false };
  }

  async swapOf(swapId) {
    return { ...this._swap(swapId) };
  }

  async swapCount() {
    return this.swaps.length;
  }

  async stats() {
    return { ...this.totals, paused: this._paused, swapCount: this.swaps.length, mode: this.mode };
  }

  async events() {
    return this.eventLog.slice();
  }

  // -- events -----------------------------------------------------------

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(name, args) {
    const event = { seq: this.eventLog.length, name, args, at: this.now() };
    this.eventLog.push(event);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* never let a listener break the ledger */
      }
    }
  }
}

// ---------------------------------------------------------------- chain

function loadEthers() {
  const candidates = ["ethers", path.join(__dirname, "..", "contracts", "node_modules", "ethers")];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("LEDGER=chain needs ethers. Run `npm install` in contracts/ first.");
}

// Hardhat's well-known development accounts. Local demo chain only.
const HARDHAT_KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  verifier: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  redeemer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  fulfiller: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  stranger: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
};

class ChainLedger {
  constructor({ deployment, keys = HARDHAT_KEYS } = {}) {
    this.mode = "chain";
    const ethers = loadEthers();
    this.ethers = ethers;
    this.deployment = deployment ?? ChainLedger.loadDeployment();
    // No RPC result caching: two quick transactions from one key must see fresh nonces.
    this.provider = new ethers.JsonRpcProvider(this.deployment.rpcUrl, undefined, { cacheTimeout: -1 });
    this.keys = keys;
    this.wallets = new Map();
    this.addresses = new Map();
    this.contract = new ethers.Contract(this.deployment.address, this.deployment.abi, this.provider);
    this.listeners = new Set();
    this.roleHashes = null;
  }

  static loadDeployment() {
    const file = path.join(__dirname, "..", "shared", "deployment.json");
    if (!fs.existsSync(file)) {
      throw new Error("shared/deployment.json not found — run `npx hardhat run scripts/deploy.js --network localhost` in contracts/ first");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  _as(actor) {
    if (!this.wallets.has(actor)) {
      const key = this.keys[actor] ?? this.keys.stranger;
      const wallet = new this.ethers.Wallet(key, this.provider);
      this.addresses.set(actor, wallet.address);
      // NonceManager tracks nonces locally so back-to-back sends never reuse one.
      this.wallets.set(actor, this.contract.connect(new this.ethers.NonceManager(wallet)));
    }
    return this.wallets.get(actor);
  }

  _address(actor) {
    this._as(actor);
    return this.addresses.get(actor);
  }

  async _roleHash(role) {
    if (role === ROLES.DEFAULT_ADMIN_ROLE) return ZERO32;
    if (!this.roleHashes) {
      this.roleHashes = {};
      for (const r of [ROLES.ADMIN_ROLE, ROLES.VERIFIER_ROLE, ROLES.REDEEMER_ROLE, ROLES.FULFILLER_ROLE]) {
        this.roleHashes[r] = await this.contract[r]();
      }
    }
    return this.roleHashes[role];
  }

  _translate(err) {
    const revert = err?.revert ?? null;
    if (revert?.name) return new LedgerError(revert.name, Object.fromEntries((revert.args ?? []).map((v, i) => [i, String(v)])));
    const data = err?.data ?? err?.info?.error?.data;
    if (typeof data === "string") {
      try {
        const parsed = this.contract.interface.parseError(data);
        if (parsed) return new LedgerError(parsed.name, Object.fromEntries(parsed.fragment.inputs.map((inp, i) => [inp.name, String(parsed.args[i])])));
      } catch {
        /* fall through */
      }
    }
    return err;
  }

  async _send(actor, method, ...args) {
    try {
      const tx = await this._as(actor)[method](...args);
      const receipt = await tx.wait();
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed) this._emit(this._eventFrom(parsed, log));
        } catch {
          /* not ours */
        }
      }
      return receipt;
    } catch (err) {
      throw this._translate(err);
    }
  }

  _eventFrom(parsed, log) {
    return {
      seq: `${log.blockNumber}:${log.index}`,
      name: parsed.name,
      args: Object.fromEntries(parsed.fragment.inputs.map((inp, i) => [inp.name, normalise(parsed.args[i])])),
      at: null,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
    };
  }

  async hasRole(role, account) {
    return this.contract.hasRole(await this._roleHash(role), this._address(account));
  }
  async grantRole(actor, role, account) {
    return this._send(actor, "grantRole", await this._roleHash(role), this._address(account));
  }
  async configureMission(actor, missionId, reward, version, active) {
    return this._send(actor, "configureMission", missionId, BigInt(reward), Number(version), Boolean(active));
  }
  async configureCatalogItem(actor, itemId, productCode, cost, inventory, active) {
    return this._send(actor, "configureCatalogItem", itemId, productCode, BigInt(cost), BigInt(inventory), Boolean(active));
  }
  async pause(actor) {
    return this._send(actor, "pause");
  }
  async unpause(actor) {
    return this._send(actor, "unpause");
  }
  async paused() {
    return this.contract.paused();
  }
  async awardCredits(actor, learnerHash, missionId, proofHash) {
    const mission = await this.missionOf(missionId);
    await this._send(actor, "awardCredits", learnerHash, missionId, proofHash);
    const account = await this.accountOf(learnerHash);
    return { amount: mission.reward, version: mission.version, expiresAt: account.expiresAt };
  }
  async sweepExpired(learnerHash) {
    return this._send("stranger", "sweepExpired", learnerHash);
  }
  async requestSwap(actor, learnerHash, itemId, requestHash) {
    const before = await this.swapCount();
    await this._send(actor, "requestSwap", learnerHash, itemId, requestHash);
    return before;
  }
  async settleSwap(actor, swapId, voucherCommitment) {
    return this._send(actor, "settleSwap", BigInt(swapId), voucherCommitment);
  }
  async cancelSwap(actor, swapId, reason) {
    return this._send(actor, "cancelSwap", BigInt(swapId), reason);
  }
  async balanceOf(learnerHash) {
    return Number(await this.contract.balanceOf(learnerHash));
  }
  async accountOf(learnerHash) {
    const a = await this.contract.accountOf(learnerHash);
    return { balance: Number(a.balance), lifetimeAwarded: Number(a.lifetimeAwarded), expiresAt: Number(a.expiresAt) };
  }
  async missionCompleted(learnerHash, missionId) {
    return this.contract.missionCompleted(learnerHash, missionId);
  }
  async missionOf(missionId) {
    const m = await this.contract.missionOf(missionId);
    return { reward: Number(m.reward), version: Number(m.version), active: m.active, exists: m.exists };
  }
  async itemOf(itemId) {
    const i = await this.contract.itemOf(itemId);
    return { productCode: i.productCode, cost: Number(i.cost), inventory: Number(i.inventory), active: i.active, exists: i.exists };
  }
  async swapOf(swapId) {
    try {
      const s = await this.contract.swapOf(BigInt(swapId));
      return {
        swapId: Number(swapId),
        learnerHash: s.learnerHash,
        itemId: s.itemId,
        requestHash: s.requestHash,
        voucherCommitment: s.voucherCommitment,
        cost: Number(s.cost),
        status: SWAP_STATUS[Number(s.status)],
      };
    } catch (err) {
      throw this._translate(err);
    }
  }
  async swapCount() {
    return Number(await this.contract.swapCount());
  }
  async stats() {
    const [awarded, outstanding, inSwap, swapped, expired, paused, swapCount] = await Promise.all([
      this.contract.totalAwarded(),
      this.contract.totalOutstanding(),
      this.contract.totalInSwap(),
      this.contract.totalSwapped(),
      this.contract.totalExpired(),
      this.contract.paused(),
      this.contract.swapCount(),
    ]);
    return {
      awarded: Number(awarded),
      outstanding: Number(outstanding),
      inSwap: Number(inSwap),
      swapped: Number(swapped),
      expired: Number(expired),
      paused,
      swapCount: Number(swapCount),
      mode: this.mode,
      address: this.deployment.address,
    };
  }
  async events() {
    const logs = await this.contract.queryFilter("*", 0, "latest");
    return logs.filter((l) => l.fragment).map((l) => this._eventFrom({ name: l.fragment.name, fragment: l.fragment, args: l.args }, l));
  }
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  }
}

const normalise = (v) => (typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v);

/** Pick the ledger from the environment. */
function createLedger(env = process.env) {
  if (env.LEDGER === "chain") return new ChainLedger();
  return new MemoryLedger();
}

module.exports = {
  ROLES,
  MAX_MISSION_REWARD,
  LIFETIME_CAP,
  CREDIT_TTL,
  LedgerError,
  MemoryLedger,
  ChainLedger,
  HARDHAT_KEYS,
  createLedger,
  ZERO32,
};

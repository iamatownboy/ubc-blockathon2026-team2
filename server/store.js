// Off-chain state with a PII refusal check and short-lived review content.
//
// What lives here: sessions (random handle ↔ device public key), structured
// submission audit records, short-lived pending review text, swap records
// with *sealed* card blobs, and the service log. Direct identifiers that the
// filters recognise are refused by key and by value. Free text is retained
// only while a near-miss awaits review, then removed on decision or expiry.
//
// Session tokens, audit metadata and reviews stay in memory. In chain mode,
// the main process supplies a file so only device public keys and sealed swap
// records survive a restart for idempotent order recovery.
"use strict";

const fs = require("fs");
const path = require("path");

const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;

class PIIRefusedError extends Error {
  constructor(path, why) {
    super(`store refused to write ${path}: ${why}`);
    this.name = "PIIRefusedError";
    this.path = path;
  }
}

// Key names that would only ever hold personal information. Matched on the
// normalised key (lower-case, no separators), as whole words.
const FORBIDDEN_KEYS = new Set([
  "name", "firstname", "lastname", "fullname", "surname", "givenname", "displayname",
  "email", "emailaddress", "mail",
  "phone", "phonenumber", "mobile", "tel", "telephone",
  "address", "streetaddress", "street", "postalcode", "postcode", "zip", "zipcode",
  "deviceid", "imei", "udid", "ipaddress", "ip",
  "dob", "dateofbirth", "birthdate", "sin", "passport",
  // bearer value that must only ever be stored sealed
  "cardnbr", "cardnumber", "pan", "pin",
]);

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// A phone number with separators: (604) 555-0199, 604-555-0199, +1 604 555 0199
const PHONE_PATTERN = /(?:\+?\d{1,2}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
// A 15–19 digit run (a card number) — hex ids contain letters and never match.
const CARD_PATTERN = /(?<!\d)\d{15,19}(?!\d)/;
const HEX_PATTERN = /^0x[0-9a-f]+$/i;

const normaliseKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

function assertNoPII(value, path = "$") {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (EMAIL_PATTERN.test(value)) throw new PIIRefusedError(path, "value looks like an e-mail address");
    if (PHONE_PATTERN.test(value)) throw new PIIRefusedError(path, "value looks like a phone number");
    // hex identifiers (handles, hashes) can legitimately contain long digit runs
    if (!HEX_PATTERN.test(value) && CARD_PATTERN.test(value)) {
      throw new PIIRefusedError(path, "value looks like a card number");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPII(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(normaliseKey(k))) {
        throw new PIIRefusedError(`${path}.${k}`, "key names personal information");
      }
      assertNoPII(v, `${path}.${k}`);
    }
  }
}

class Collection {
  constructor(name, onChange = null) {
    this.name = name;
    this.onChange = onChange;
    this.rows = new Map();
  }
  put(id, row) {
    assertNoPII(row, `${this.name}[${id}]`);
    this.rows.set(id, row);
    if (this.onChange) this.onChange();
    return row;
  }
  get(id) {
    return this.rows.get(id) ?? null;
  }
  has(id) {
    return this.rows.has(id);
  }
  delete(id) {
    const deleted = this.rows.delete(id);
    if (deleted && this.onChange) this.onChange();
    return deleted;
  }
  values() {
    return [...this.rows.values()];
  }
  find(pred) {
    return this.values().filter(pred);
  }
  get size() {
    return this.rows.size;
  }
}

class Store {
  constructor({ reviewTtlMs = REVIEW_TTL_MS, now = () => Date.now(), file = null } = {}) {
    this.reviewTtlMs = reviewTtlMs;
    this.now = now;
    this.file = file ? path.resolve(file) : null;
    this.loading = true;
    this.sessions = new Collection("sessions"); // token -> { handle, publicKey, language, createdAt }
    this.submissions = new Collection("submissions"); // id -> graded submission
    this.reviewQueue = new Collection("reviewQueue"); // submissionId -> queued review
    // Only pseudonymous device public keys and sealed swap state are durable.
    // Session bearer tokens and learner-written review text remain memory-only.
    this.devices = new Collection("devices", () => this.persist()); // handle -> { publicKey }
    this.swaps = new Collection("swaps", () => this.persist()); // swapId -> swap record (sealed card only)
    this.logEntries = [];
    this.listeners = new Set();
    this.load();
    this.loading = false;
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const [id, row] of parsed.devices ?? []) this.devices.put(id, row);
    for (const [id, row] of parsed.swaps ?? []) this.swaps.put(id, row);
  }

  persist() {
    if (!this.file || this.loading) return;
    const state = {
      version: 1,
      devices: [...this.devices.rows.entries()],
      swaps: [...this.swaps.rows.entries()],
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Remove learner-written text as soon as a review reaches a final state. */
  finalizeReview(id, status, fields = {}) {
    const row = this.reviewQueue.get(id);
    if (!row) return null;
    row.status = status;
    row.decidedAt = new Date(this.now()).toISOString();
    Object.assign(row, fields);
    delete row.answers;
    delete row.attempts;
    this.reviewQueue.put(id, row);
    return row;
  }

  /** Expire abandoned reviews without retaining the learner's raw words. */
  expireReviews() {
    const now = this.now();
    let count = 0;
    for (const row of this.reviewQueue.values()) {
      if (row.status !== "pending") continue;
      const deadline = Date.parse(row.reviewExpiresAt ?? "");
      if (!Number.isFinite(deadline) || deadline > now) continue;
      this.finalizeReview(row.id, "expired");
      count += 1;
    }
    return count;
  }

  /** Service log. Every entry passes the PII check before it is kept. */
  log(event, fields = {}) {
    const entry = { at: new Date().toISOString(), event, ...fields };
    assertNoPII(entry, `log.${event}`);
    this.logEntries.push(entry);
    if (this.logEntries.length > 2000) this.logEntries.shift();
    for (const fn of this.listeners) {
      try {
        fn({ type: "log", entry });
      } catch {
        /* a broken listener never breaks the service */
      }
    }
    return entry;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(message) {
    for (const fn of this.listeners) {
      try {
        fn(message);
      } catch {
        /* ignore */
      }
    }
  }

  /** Everything the store holds, for the privacy tests. */
  dump() {
    return {
      sessions: this.sessions.values(),
      devices: this.devices.values(),
      submissions: this.submissions.values(),
      reviewQueue: this.reviewQueue.values(),
      swaps: this.swaps.values(),
      log: this.logEntries,
    };
  }
}

module.exports = { Store, Collection, assertNoPII, PIIRefusedError, FORBIDDEN_KEYS, REVIEW_TTL_MS };

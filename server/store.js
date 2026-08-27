// Off-chain state, in memory, with a PII refusal check.
//
// What lives here: sessions (random handle ↔ device public key), submissions
// and the review queue, swap records with *sealed* card blobs, and the
// service log. What can never live here: a name, e-mail, phone number,
// street address or device id. The store refuses to write them at all —
// by key and by value — so the mistake is not available even by accident.
//
// State is in memory. Restarting the server clears every learner, balance
// and wallet — stated as a limit, not hidden.
"use strict";

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
  constructor(name) {
    this.name = name;
    this.rows = new Map();
  }
  put(id, row) {
    assertNoPII(row, `${this.name}[${id}]`);
    this.rows.set(id, row);
    return row;
  }
  get(id) {
    return this.rows.get(id) ?? null;
  }
  has(id) {
    return this.rows.has(id);
  }
  delete(id) {
    return this.rows.delete(id);
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
  constructor() {
    this.sessions = new Collection("sessions"); // token -> { handle, publicKey, language, createdAt }
    this.submissions = new Collection("submissions"); // id -> graded submission
    this.reviewQueue = new Collection("reviewQueue"); // submissionId -> queued review
    this.swaps = new Collection("swaps"); // swapId -> swap record (sealed card only)
    this.logEntries = [];
    this.listeners = new Set();
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
      submissions: this.submissions.values(),
      reviewQueue: this.reviewQueue.values(),
      swaps: this.swaps.values(),
      log: this.logEntries,
    };
  }
}

module.exports = { Store, Collection, assertNoPII, PIIRefusedError, FORBIDDEN_KEYS };

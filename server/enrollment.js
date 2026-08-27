// Who is allowed to earn, and how one person stays one person.
//
// The problem this file exists for: the learner identity used to be a fresh
// random handle per device key, so clearing the site's data produced a brand
// new learner — and with it a brand new lifetime cap. One person could farm
// the sponsor budget by resetting a browser.
//
// The fix is deliberately low-tech, because the users are newcomers without
// stable phones, e-mail or ID: a partner (library, settlement agency, school)
// hands out a printed participation code. The server never stores the code,
// only an HMAC of it, and derives the learner handle from the same HMAC. So:
//
//   * the same code always maps to the same handle — clearing site data
//     restores the learner instead of resetting the lifetime cap;
//   * an unissued code cannot open a session at all;
//   * the server holds no phone number, no e-mail, no name — the code is the
//     only link, and it lives on paper at the partner desk.
//
// Codes are checked in constant time and normalised so that "welcome-01",
// "WELCOME 01" and "Welcome01" are the same code to a nervous typist.
"use strict";

const crypto = require("crypto");

/** Demo codes shipped for the local run. Never used when NODE_ENV=production. */
const DEMO_CODES = Array.from({ length: 12 }, (_, i) => `WELCOME-${String(i + 1).padStart(2, "0")}`);

const normalize = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function createEnrollment({
  secret,
  mode = process.env.ENROLLMENT ?? "required",
  codes = process.env.ENROLLMENT_CODES,
  production = process.env.NODE_ENV === "production",
} = {}) {
  if (!secret) throw new Error("enrollment needs an identity secret");
  const required = mode !== "open";

  let list;
  if (typeof codes === "string" && codes.trim()) list = codes.split(",");
  else if (Array.isArray(codes)) list = codes;
  else if (production) list = [];
  else list = DEMO_CODES;

  const allowed = new Set(list.map(normalize).filter(Boolean));
  if (required && allowed.size === 0) {
    throw new Error("ENROLLMENT=required needs ENROLLMENT_CODES (a partner-issued code list)");
  }

  /** Digest of a code. The code itself is never stored, logged or returned. */
  const digest = (code) =>
    crypto.createHmac("sha256", String(secret)).update("languagetoken/enrollment/v1\0").update(normalize(code)).digest();

  const digests = new Map();
  for (const code of allowed) digests.set(code, digest(code));

  /** Constant-time membership test, so a code cannot be guessed by timing. */
  function accepts(code) {
    const given = digest(code);
    let ok = false;
    for (const known of digests.values()) {
      if (crypto.timingSafeEqual(given, known)) ok = true;
    }
    return ok;
  }

  /**
   * The learner handle for a code. Deterministic, so the same paper code
   * always reaches the same balance, lifetime cap and completed missions —
   * on a new device, or after the learner clears the browser.
   */
  const handleFor = (code) => "0x" + digest(code).toString("hex");

  return {
    required,
    mode: required ? "required" : "open",
    size: allowed.size,
    /** Only ever non-empty outside production — for the demo screen. */
    demoCodes: production || (typeof codes === "string" && codes.trim()) || Array.isArray(codes) ? [] : [...DEMO_CODES],
    normalize,
    accepts,
    handleFor,
  };
}

module.exports = { createEnrollment, DEMO_CODES, normalize };

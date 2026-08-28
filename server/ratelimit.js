// A sliding window, per key, in memory.
//
// It exists for one reason: a participation code is the only thing standing
// between a stranger and a gift card, and codes are short enough to type at a
// library desk. Without a limit, guessing them is a loop. With one, an
// attacker gets a handful of tries per address per window and then waits.
//
// Deliberately small: one process, no store, no dependency. It is not a
// distributed limiter and does not pretend to be — a real deployment behind
// several instances needs a shared counter, and the README says so.
//
// What it never holds: the code that was tried, or anything about the person.
// Only a key (an address), and timestamps.
"use strict";

const MAX_KEYS = 5000;

function createRateLimiter({ limit, windowMs, now = () => Date.now() } = {}) {
  if (!(limit > 0) || !(windowMs > 0)) throw new Error("rate limiter needs a positive limit and window");
  const hits = new Map();

  const fresh = (key, t) => {
    const arr = hits.get(key) ?? [];
    let i = 0;
    while (i < arr.length && arr[i] <= t - windowMs) i += 1;
    const kept = i ? arr.slice(i) : arr;
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  };

  /** Drop everything that has aged out, then the coldest keys if still large. */
  const sweep = (t) => {
    for (const key of [...hits.keys()]) fresh(key, t);
    if (hits.size <= MAX_KEYS) return;
    const byAge = [...hits.entries()].sort((a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1]);
    for (const [key] of byAge.slice(0, hits.size - MAX_KEYS)) hits.delete(key);
  };

  return {
    limit,
    windowMs,
    /** 0 when the key may try again now; otherwise the wait in milliseconds. */
    retryAfterMs(key) {
      const t = now();
      const arr = fresh(key, t);
      if (arr.length < limit) return 0;
      return Math.max(1, arr[0] + windowMs - t);
    },
    /** Count one failure against the key. Returns how many are in the window. */
    record(key) {
      const t = now();
      const arr = fresh(key, t).concat(t);
      hits.set(key, arr);
      if (hits.size > MAX_KEYS) sweep(t);
      return arr.length;
    },
    /** Success forgives the key: a learner who mistypes twice is not punished. */
    clear(key) {
      hits.delete(key);
    },
    size() {
      return hits.size;
    },
  };
}

/**
 * Who to count against. `remoteAddress` is the only value a client cannot
 * choose for itself, so it is the default. X-Forwarded-For is trusted only
 * when the operator says a proxy sets it — trusting it by default would let
 * anyone reset their own counter with a header.
 */
function clientKey(req, { trustProxy = process.env.TRUST_PROXY === "1" } = {}) {
  if (trustProxy) {
    const fwd = req.headers?.["x-forwarded-for"];
    const first = String(fwd ?? "").split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

module.exports = { createRateLimiter, clientKey, MAX_KEYS };

// LanguageToken — the API, and host for the three clients.
//
//   node server/server.js
//
// No install step, no framework. Starts the mock gift card provider on its
// own port (8788) unless PROVIDER_URL points somewhere else, and serves:
//
//   /learner/    the learner app          (no account, no wallet, no gas)
//   /verifier/   the review queue         (no field to type an amount into)
//   /admin/      missions, catalog, pause, the ledger event stream,
//                the service log, and the provider failure switches
//   /api/stats   readable by anyone, no login
//
// Environment:
//   PORT=8787            LEDGER=memory|chain    PROVIDER_URL=http://...
//   PROVIDER_PORT=8788   PROVIDER_CERT=...      PROVIDER_TIMEOUT_MS=4000
//   ADMIN_TOKEN=admin-demo   VERIFIER_TOKEN=verifier-demo
//   ANTHROPIC_API_KEY=...    (optional: live coach; otherwise the offline coach)
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { createLedger, verifyLedger, LedgerError, ROLES, MAX_MISSION_REWARD, LIFETIME_CAP, CREDIT_TTL } = require("./ledger");
const { Store, PIIRefusedError } = require("./store");
const { createProviderClient } = require("./bhn-client");
const { createMockProvider } = require("./bhn-mock");
const { createSwapService, plainError } = require("./swap");
const assessment = require("./assessment");
const catalog = require("./catalog");
const { handleForPublicKey, randomToken, asciiBytes32, isBytes32 } = require("./ids");
const { createEnrollment } = require("./enrollment");
const { createRateLimiter, clientKey } = require("./ratelimit");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const SECURITY_HEADERS = {
  // frame-ancestors 'self' so the demo stage can hold the learner app in a
  // frame; nothing outside this origin can frame any of it.
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};
const MIN_PRODUCTION_SECRET_BYTES = 32;
const STREAM_TICKET_TTL_MS = 60 * 1000;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function createApp({
  ledger = createLedger(),
  store = new Store(),
  providerUrl,
  providerCert = process.env.PROVIDER_CERT ?? "demo-partner-cert",
  providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 4000),
  adminToken = process.env.ADMIN_TOKEN ?? "admin-demo",
  verifierToken = process.env.VERIFIER_TOKEN ?? "verifier-demo",
  identitySecret = process.env.IDENTITY_SECRET ?? "demo-identity-secret-change-me",
  production = process.env.NODE_ENV === "production",
  enrollment,
  // Eight wrong codes from one address per ten minutes. A learner who
  // mistypes is nowhere near it; a script guessing codes is stopped at eight.
  codeAttemptLimit = Number(process.env.CODE_ATTEMPT_LIMIT ?? 8),
  codeAttemptWindowMs = Number(process.env.CODE_ATTEMPT_WINDOW_MS ?? 10 * 60 * 1000),
  publicDir = PUBLIC_DIR,
} = {}) {
  if (!providerUrl) throw new Error("createApp needs providerUrl");
  if (production) {
    for (const [name, value] of [
      ["IDENTITY_SECRET", identitySecret],
      ["ADMIN_TOKEN", adminToken],
      ["VERIFIER_TOKEN", verifierToken],
    ]) {
      if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < MIN_PRODUCTION_SECRET_BYTES) {
        throw new Error(`${name} must contain at least ${MIN_PRODUCTION_SECRET_BYTES} bytes in production`);
      }
    }
    if (new Set([identitySecret, adminToken, verifierToken]).size !== 3) {
      throw new Error("IDENTITY_SECRET, ADMIN_TOKEN and VERIFIER_TOKEN must all be different in production");
    }
  }
  const enrol = enrollment ?? createEnrollment({ secret: identitySecret, production });
  const codeAttempts = createRateLimiter({ limit: codeAttemptLimit, windowMs: codeAttemptWindowMs });
  const provider = createProviderClient({ baseUrl: providerUrl, cert: providerCert, timeoutMs: providerTimeoutMs });
  const swaps = createSwapService({ ledger, store, provider });
  const streams = new Set();
  const streamTickets = new Map();

  // Every ledger event and log line reaches the admin console's live stream.
  ledger.onEvent((event) => broadcast({ type: "ledger", event }));
  store.subscribe((message) => broadcast(message));

  function broadcast(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of streams) {
      try {
        res.write(line);
      } catch {
        streams.delete(res);
      }
    }
  }

  // -------------------------------------------------------------- seeding

  /** Roles, missions and catalog — what deploy.js does for the chain. */
  async function seed() {
    if (ledger.mode === "memory") {
      for (const [role, actor] of [
        [ROLES.VERIFIER_ROLE, "verifier"],
        [ROLES.REDEEMER_ROLE, "redeemer"],
        [ROLES.FULFILLER_ROLE, "fulfiller"],
      ]) {
        if (!(await ledger.hasRole(role, actor))) await ledger.grantRole("admin", role, actor);
      }
      for (const m of assessment.MISSIONS) {
        const current = await ledger.missionOf(m.missionId);
        if (!current.exists) await ledger.configureMission("admin", m.missionId, m.reward, m.version, true);
      }
      for (const item of catalog.all()) {
        const current = await ledger.itemOf(item.itemId);
        if (!current.exists) {
          await ledger.configureCatalogItem("admin", item.itemId, asciiBytes32(item.productCode), item.cost, item.inventory, true);
        }
      }
    }
    await swaps.recoverPending();
    store.log("service.seeded", { ledger: ledger.mode, missions: assessment.MISSIONS.length, items: catalog.ITEMS.length });
  }

  // -------------------------------------------------------------- helpers

  const json = (res, status, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > limit) {
          reject(new HttpError(413, "too_large", "request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          const parsed = JSON.parse(data);
          resolve(parsed && typeof parsed === "object" ? parsed : {});
        } catch {
          reject(new HttpError(400, "bad_json", "request body must be JSON"));
        }
      });
      req.on("error", reject);
    });

  function requireSession(req) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? store.sessions.get(token) : null;
    if (!session) throw new HttpError(401, "no_session", "open the app to start a session");
    return session;
  }

  const secretEquals = (given, expected) => {
    if (typeof given !== "string" || typeof expected !== "string") return false;
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  function requireRole(req, role) {
    const expected = role === "admin" ? adminToken : verifierToken;
    const given = req.headers["x-role-token"];
    if (!secretEquals(given, expected)) throw new HttpError(401, "role_required", `${role} token required`);
    return role;
  }

  function issueStreamTicket() {
    const now = Date.now();
    for (const [ticket, expiresAt] of streamTickets) if (expiresAt <= now) streamTickets.delete(ticket);
    const ticket = randomToken(24);
    streamTickets.set(ticket, now + STREAM_TICKET_TTL_MS);
    return ticket;
  }

  function consumeStreamTicket(url) {
    const ticket = url.searchParams.get("ticket");
    const expiresAt = ticket ? streamTickets.get(ticket) : null;
    if (!ticket || !expiresAt || expiresAt <= Date.now()) throw new HttpError(401, "stream_ticket_required", "a fresh admin stream ticket is required");
    streamTickets.delete(ticket);
  }

  const assertJwk = (jwk) => {
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new HttpError(400, "bad_public_key", "publicKey must be a P-256 EC JWK");
    }
    const candidate = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
    try {
      const key = crypto.createPublicKey({ key: candidate, format: "jwk" });
      const canonical = key.export({ format: "jwk" });
      return { kty: "EC", crv: "P-256", x: canonical.x, y: canonical.y };
    } catch {
      throw new HttpError(400, "bad_public_key", "publicKey must be a valid P-256 EC JWK");
    }
  };

  const language = (v) => (typeof v === "string" && /^[a-z]{2}$/.test(v) ? v : "en");

  async function missionView(m, session) {
    store.expireReviews();
    const cfg = await ledger.missionOf(m.missionId);
    const completed = session ? await ledger.missionCompleted(session.handle, m.missionId) : false;
    const pending = session
      ? store.reviewQueue.find((r) => r.handle === session.handle && r.missionId === m.missionId && r.status === "pending").length > 0
      : false;
    return { ...assessment.missionForClient(m), reward: cfg.exists ? cfg.reward : m.reward, version: cfg.exists ? cfg.version : m.version, active: cfg.exists ? cfg.active : false, completed, pending };
  }

  async function catalogView() {
    const out = [];
    for (const item of catalog.all()) {
      const cfg = await ledger.itemOf(item.itemId);
      out.push({
        itemId: item.itemId,
        slug: item.slug,
        brand: item.brand,
        icon: item.icon,
        title: item.title,
        where: item.where,
        productCode: item.productCode,
        valueCad: item.valueCad,
        cost: cfg.exists ? cfg.cost : item.cost,
        inventory: cfg.exists ? cfg.inventory : 0,
        active: cfg.exists ? cfg.active : false,
      });
    }
    return out;
  }

  async function providerAdmin(method, p, body) {
    try {
      const res = await fetch(providerUrl + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return await res.json();
    } catch {
      return { error: "provider_admin_unavailable" };
    }
  }

  // -------------------------------------------------------------- routes

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- learner --------------------------------------------------------

  route("POST", /^\/api\/session$/, async ({ req, body }) => {
    // Re-attach an existing session (the token lives in the learner's IndexedDB).
    if (typeof body.token === "string" && store.sessions.has(body.token)) {
      const s = store.sessions.get(body.token);
      if (body.language) s.language = language(body.language);
      return { token: body.token, handle: s.handle, language: s.language, resumed: true };
    }
    const publicKey = assertJwk(body.publicKey);
    // The handle comes from the partner-issued participation code, not from
    // the device. Clearing the browser therefore restores the same learner —
    // the same balance, the same completed missions, the same lifetime cap —
    // instead of minting a fresh one that could be farmed for another card.
    let handle;
    if (enrol.required) {
      const code = typeof body.enrollmentCode === "string" ? body.enrollmentCode : "";
      if (!code.trim()) throw new HttpError(403, "enrollment_required", "a participation code from a partner desk is required");
      // A code is short enough to guess in a loop, so wrong ones are counted.
      const caller = clientKey(req);
      const waitMs = codeAttempts.retryAfterMs(caller);
      if (waitMs > 0) {
        const retryAfterSeconds = Math.ceil(waitMs / 1000);
        store.log("enrollment.throttled", { retryAfterSeconds }); // never the address, never the code
        throw new HttpError(429, "too_many_attempts", "too many participation codes have been tried from here; wait and try again", { retryAfterSeconds });
      }
      if (!enrol.accepts(code)) {
        const attempts = codeAttempts.record(caller);
        store.log("enrollment.rejected", { attempts, of: codeAttempts.limit });
        throw new HttpError(403, "enrollment_invalid", "that participation code is not on the programme list");
      }
      codeAttempts.clear(caller); // a correct code forgives earlier typos
      handle = enrol.handleFor(code);
    } else {
      handle = handleForPublicKey(publicKey, identitySecret);
    }
    const token = randomToken(24);
    const session = { handle, publicKey, language: language(body.language), createdAt: new Date().toISOString() };
    store.sessions.put(token, session);
    // Cards are sealed to whichever device key most recently proved this code.
    store.devices.put(handle, { handle, publicKey, updatedAt: new Date().toISOString() });
    store.log("session.opened", { handle, enrolled: enrol.required });
    return { token, handle, language: session.language, resumed: false, enrolled: enrol.required };
  });

  route("GET", /^\/api\/enrollment$/, async () => ({ required: enrol.required, demoCodes: enrol.demoCodes }));

  route("GET", /^\/api\/me$/, async ({ req }) => {
    const session = requireSession(req);
    const account = await ledger.accountOf(session.handle);
    const balance = await ledger.balanceOf(session.handle);
    return {
      handle: session.handle,
      language: session.language,
      balance,
      expiresAt: account.expiresAt,
      lifetimeAwarded: account.lifetimeAwarded,
      lifetimeCap: LIFETIME_CAP,
      ttlDays: CREDIT_TTL / 86400,
      paused: await ledger.paused(),
      ledgerMode: ledger.mode,
    };
  });

  route("GET", /^\/api\/missions$/, async ({ req }) => {
    let session = null;
    try {
      session = requireSession(req);
    } catch {
      /* anonymous listing is fine */
    }
    const missions = [];
    for (const m of assessment.MISSIONS) missions.push(await missionView(m, session));
    return { missions, coach: assessment.liveCoachAvailable() ? "live" : "offline" };
  });

  route("POST", /^\/api\/coach$/, async ({ req, body }) => {
    const session = requireSession(req);
    const m = assessment.getMission(body.missionId);
    if (!m) throw new HttpError(404, "unknown_mission", "unknown mission");
    const attempts = Array.isArray(body.attempts) ? body.attempts.slice(0, 5).map((a) => String(a ?? "").slice(0, 400)) : [];
    const lang = language(body.language ?? session.language);
    const { feedback, source } = await assessment.coach({ mission: m, attempts, language: lang, allowLive: body.allowExternalCoach === true });
    // Coach output is returned, never stored.
    return { feedback, source };
  });

  route("POST", /^\/api\/submit$/, async ({ req, body }) => {
    const session = requireSession(req);
    const m = assessment.getMission(body.missionId);
    if (!m) throw new HttpError(404, "unknown_mission", "unknown mission");
    const submission = {
      answers: body.answers && typeof body.answers === "object" ? body.answers : {},
      attempts: Array.isArray(body.attempts) ? body.attempts.slice(0, 5).map((a) => String(a ?? "").slice(0, 400)) : [],
    };
    // Anything else in the body — pass, credits, amount — is not read.
    const result = assessment.grade(m, submission);
    const id = randomToken(12);
    const record = {
      id,
      handle: session.handle,
      missionId: m.missionId,
      slug: m.slug,
      version: m.version,
      outcome: result.outcome,
      criteria: result.criteria,
      missed: result.missed,
      at: new Date().toISOString(),
    };
    store.submissions.put(id, record);

    if (result.outcome === "passed") {
      const proofHash = assessment.proofHash(session.handle, m, submission, randomToken(8));
      try {
        const award = await ledger.awardCredits("verifier", session.handle, m.missionId, proofHash);
        store.log("mission.awarded", { handle: session.handle, mission: m.slug, amount: award.amount, by: "verifier" });
        return { outcome: "passed", criteria: result.criteria, awarded: award.amount, balance: await ledger.balanceOf(session.handle), expiresAt: award.expiresAt };
      } catch (err) {
        if (err instanceof LedgerError) {
          const plain = plainError(err);
          return { outcome: "passed", criteria: result.criteria, awarded: 0, notAwarded: plain, balance: await ledger.balanceOf(session.handle) };
        }
        throw err;
      }
    }
    if (result.outcome === "review") {
      store.reviewQueue.put(id, {
        ...record,
        status: "pending",
        answers: submission.answers,
        attempts: submission.attempts,
        reviewExpiresAt: new Date(store.now() + store.reviewTtlMs).toISOString(),
      });
      store.log("mission.review_queued", { handle: session.handle, mission: m.slug, missed: result.missed });
      return { outcome: "review", criteria: result.criteria, missed: result.missed, reviewId: id };
    }
    store.log("mission.failed", { handle: session.handle, mission: m.slug, missed: result.missed });
    return { outcome: "failed", criteria: result.criteria, missed: result.missed };
  });

  route("GET", /^\/api\/reviews$/, async ({ req }) => {
    const session = requireSession(req);
    store.expireReviews();
    const mine = store.reviewQueue.find((r) => r.handle === session.handle).map((r) => ({ id: r.id, missionId: r.missionId, slug: r.slug, status: r.status, at: r.at, decidedAt: r.decidedAt, awarded: r.awarded }));
    return { reviews: mine };
  });

  route("GET", /^\/api\/catalog$/, async () => ({ items: await catalogView(), creditsPerCad: catalog.CREDITS_PER_CAD }));

  route("POST", /^\/api\/swap$/, async ({ req, body }) => {
    const session = requireSession(req);
    if (!isBytes32(body.itemId)) throw new HttpError(400, "bad_item", "itemId must be bytes32");
    try {
      const result = await swaps.swap({ session, itemId: body.itemId });
      return { ...result, balance: await ledger.balanceOf(session.handle) };
    } catch (err) {
      if (err instanceof LedgerError || err.name === "ItemNotAvailable") {
        const plain = plainError(err);
        throw new HttpError(409, plain.code, plain.message);
      }
      throw err;
    }
  });

  route("GET", /^\/api\/wallet$/, async ({ req }) => {
    const session = requireSession(req);
    return { cards: swaps.walletOf(session) };
  });

  route("POST", /^\/api\/wallet\/(\d+)\/reveal$/, async ({ req, params }) => {
    const session = requireSession(req);
    const card = swaps.reveal({ session, swapId: params[0] });
    if (!card) throw new HttpError(404, "no_card", "no settled card with that id in this wallet");
    return card;
  });

  // ---- public ---------------------------------------------------------

  route("GET", /^\/api\/stats$/, async () => {
    store.expireReviews();
    const stats = await ledger.stats();
    const missions = [];
    for (const m of assessment.MISSIONS) {
      const cfg = await ledger.missionOf(m.missionId);
      missions.push({
        missionId: m.missionId,
        slug: m.slug,
        title: m.title.en,
        reward: cfg.reward,
        version: cfg.version,
        active: cfg.active,
        awards: store.submissions.find((s) => s.missionId === m.missionId && s.outcome === "passed").length,
      });
    }
    const swapRecords = store.swaps.values();
    return {
      programme: "LanguageToken",
      ledger: stats,
      limits: { maxMissionReward: MAX_MISSION_REWARD, lifetimeCap: LIFETIME_CAP, creditTtlDays: CREDIT_TTL / 86400, creditsPerCad: catalog.CREDITS_PER_CAD },
      learners: store.sessions.size,
      missions,
      catalog: (await catalogView()).map(({ slug, brand, productCode, cost, inventory, active }) => ({ slug, brand, productCode, cost, inventory, active })),
      swaps: {
        requested: swapRecords.filter((s) => s.status === "Requested").length,
        settled: swapRecords.filter((s) => s.status === "Settled").length,
        cancelled: swapRecords.filter((s) => s.status === "Cancelled").length,
        recovered: swapRecords.filter((s) => s.recovered).length,
      },
      reviews: { pending: store.reviewQueue.find((r) => r.status === "pending").length },
      coach: assessment.liveCoachAvailable() ? "live" : "offline",
    };
  });

  route("GET", /^\/api\/events$/, async () => ({ events: await ledger.events() }));

  // ---- verifier -------------------------------------------------------

  route("GET", /^\/api\/verifier\/queue$/, async ({ req, url }) => {
    requireRole(req, "verifier");
    store.expireReviews();
    const queue = store.reviewQueue.values().sort((a, b) => (a.at < b.at ? 1 : -1));
    const out = [];
    for (const r of queue) {
      const m = assessment.getMission(r.missionId);
      const cfg = await ledger.missionOf(r.missionId);
      out.push({
        id: r.id,
        handle: r.handle,
        missionId: r.missionId,
        slug: r.slug,
        title: m?.title.en ?? r.slug,
        configuredReward: cfg.reward,
        status: r.status,
        at: r.at,
        decidedAt: r.decidedAt,
        awarded: r.awarded,
        criteria: r.criteria.map((c) => ({ ...c, label: c.label?.en ?? c.id })),
        missed: r.missed,
        attempts: r.attempts,
        answers: r.answers,
        choices: m ? m.criteria.filter((c) => c.type === "choice").map((c) => ({ id: c.id, prompt: c.prompt, choices: c.choices })) : [],
      });
    }
    return { queue: out };
  });

  route("POST", /^\/api\/verifier\/queue\/([A-Za-z0-9_-]+)\/approve$/, async ({ req, url, params, body }) => {
    requireRole(req, "verifier");
    store.expireReviews();
    const r = store.reviewQueue.get(params[0]);
    if (!r) throw new HttpError(404, "no_review", "no such review");
    if (r.status !== "pending") throw new HttpError(409, "decided", "already decided");
    if (body.amount !== undefined || body.credits !== undefined || body.reward !== undefined) {
      // There is no field to type an amount into. If one arrives anyway it is ignored and noted.
      store.log("verifier.amount_ignored", { review: r.id });
    }
    const m = assessment.getMission(r.missionId);
    const proofHash = assessment.proofHash(r.handle, m, { answers: r.answers, attempts: r.attempts }, randomToken(8));
    try {
      const award = await ledger.awardCredits("verifier", r.handle, r.missionId, proofHash);
      store.finalizeReview(r.id, "approved", { awarded: award.amount });
      store.log("mission.awarded", { handle: r.handle, mission: r.slug, amount: award.amount, by: "verifier-console", review: r.id });
      return { id: r.id, status: r.status, awarded: award.amount };
    } catch (err) {
      if (err instanceof LedgerError) {
        const plain = plainError(err);
        throw new HttpError(409, plain.code, plain.message);
      }
      throw err;
    }
  });

  route("POST", /^\/api\/verifier\/queue\/([A-Za-z0-9_-]+)\/reject$/, async ({ req, url, params }) => {
    requireRole(req, "verifier");
    store.expireReviews();
    const r = store.reviewQueue.get(params[0]);
    if (!r) throw new HttpError(404, "no_review", "no such review");
    if (r.status !== "pending") throw new HttpError(409, "decided", "already decided");
    store.finalizeReview(r.id, "rejected");
    store.log("mission.review_rejected", { handle: r.handle, mission: r.slug, review: r.id });
    return { id: r.id, status: r.status };
  });

  // ---- admin ----------------------------------------------------------

  route("GET", /^\/api\/admin\/state$/, async ({ req, url }) => {
    requireRole(req, "admin");
    const missions = [];
    for (const m of assessment.MISSIONS) {
      const cfg = await ledger.missionOf(m.missionId);
      missions.push({ missionId: m.missionId, slug: m.slug, title: m.title.en, icon: m.icon, ...cfg });
    }
    return {
      ledger: await ledger.stats(),
      limits: { maxMissionReward: MAX_MISSION_REWARD, lifetimeCap: LIFETIME_CAP, creditTtlDays: CREDIT_TTL / 86400 },
      paused: await ledger.paused(),
      missions,
      catalog: await catalogView(),
      roles: [
        { role: "ADMIN_ROLE", heldBy: "admin", can: "configure missions and catalog, pause, grant roles, cancel a swap" },
        { role: "VERIFIER_ROLE", heldBy: "verifier", can: "award the configured amount for a passed mission — nothing else" },
        { role: "REDEEMER_ROLE", heldBy: "redeemer", can: "burn credits and open a swap" },
        { role: "FULFILLER_ROLE", heldBy: "fulfiller", can: "settle a swap once the provider confirms, or cancel and refund" },
      ],
      provider: await providerAdmin("GET", "/admin/state"),
      providerUrl,
      swaps: store.swaps.values().map(({ sealed, ...rest }) => rest).sort((a, b) => b.swapId - a.swapId),
      reviews: store.reviewQueue.values().length,
      learners: store.sessions.size,
      coach: assessment.liveCoachAvailable() ? "live" : "offline",
    };
  });

  route("POST", /^\/api\/admin\/missions$/, async ({ req, url, body }) => {
    requireRole(req, "admin");
    if (!isBytes32(body.missionId)) throw new HttpError(400, "bad_mission", "missionId must be bytes32");
    const current = await ledger.missionOf(body.missionId);
    const reward = body.reward ?? current.reward;
    const version = body.version ?? current.version;
    const active = body.active ?? current.active;
    await ledger.configureMission("admin", body.missionId, reward, version, active);
    store.log("admin.mission_configured", { missionId: body.missionId, reward, version, active });
    return { mission: await ledger.missionOf(body.missionId) };
  });

  route("POST", /^\/api\/admin\/catalog$/, async ({ req, url, body }) => {
    requireRole(req, "admin");
    if (!isBytes32(body.itemId)) throw new HttpError(400, "bad_item", "itemId must be bytes32");
    const product = catalog.get(body.itemId);
    if (!product) {
      throw new HttpError(422, "unapproved_product", "catalog item must be reviewed and added to the server allowlist before it can be configured");
    }
    if (body.productCode !== undefined && body.productCode !== product.productCode) {
      throw new HttpError(422, "unapproved_product", "productCode does not match the approved catalog item");
    }
    catalog.assertClosedLoop(product); // the admin console cannot override this
    const current = await ledger.itemOf(body.itemId);
    const cost = body.cost ?? (current.exists ? current.cost : product.cost);
    const inventory = body.inventory ?? current.inventory;
    const active = body.active ?? current.active;
    await ledger.configureCatalogItem("admin", body.itemId, asciiBytes32(product.productCode), cost, inventory, active);
    store.log("admin.catalog_configured", { itemId: body.itemId, productCode: product.productCode, cost, inventory, active });
    return { item: await ledger.itemOf(body.itemId) };
  });

  route("POST", /^\/api\/admin\/catalog\/sync$/, async ({ req, url }) => {
    requireRole(req, "admin");
    // Pull the provider's catalog. assertClosedLoop runs on every product; the
    // refused ones come back by name so the console can show what was turned away.
    const products = await provider.catalog();
    const { accepted, refused } = catalog.syncFromProvider(products);
    store.log("admin.catalog_synced", { fetched: products.length, accepted: accepted.length, refused: refused.map((r) => r.productCode) });
    return { fetched: products.length, accepted, refused };
  });

  route("POST", /^\/api\/admin\/pause$/, async ({ req, url }) => {
    requireRole(req, "admin");
    await ledger.pause("admin");
    store.log("admin.paused", {});
    return { paused: true };
  });

  route("POST", /^\/api\/admin\/unpause$/, async ({ req, url }) => {
    requireRole(req, "admin");
    await ledger.unpause("admin");
    store.log("admin.unpaused", {});
    return { paused: false };
  });

  route("GET", /^\/api\/admin\/log$/, async ({ req, url }) => {
    requireRole(req, "admin");
    return { log: store.logEntries.slice(-300) };
  });

  route("GET", /^\/api\/admin\/provider$/, async ({ req, url }) => {
    requireRole(req, "admin");
    return providerAdmin("GET", "/admin/state");
  });

  route("POST", /^\/api\/admin\/provider\/mode$/, async ({ req, url, body }) => {
    requireRole(req, "admin");
    const result = await providerAdmin("POST", "/admin/mode", { mode: body.mode, once: body.once !== false });
    store.log("admin.provider_mode", { mode: body.mode, once: body.once !== false });
    return result;
  });

  route("POST", /^\/api\/admin\/swaps\/(\d+)\/cancel$/, async ({ req, url, params, body }) => {
    requireRole(req, "admin");
    try {
      return await swaps.cancel({ swapId: params[0], reason: String(body.reason ?? "admin").slice(0, 32), actor: "admin" });
    } catch (err) {
      if (err instanceof LedgerError || err?.name === "InvalidSwap" || err?.name === "ProviderPending") {
        const plain = plainError(err);
        throw new HttpError(409, plain.code, plain.message);
      }
      throw err;
    }
  });

  route("POST", /^\/api\/admin\/swaps\/(\d+)\/refund$/, async ({ req, params, body }) => {
    requireRole(req, "admin");
    // A refund is the one action that can pay twice, so it is never a side
    // effect of a button that means something else. The operator has to state,
    // in the request, that the provider confirmed no order exists.
    if (body.confirmedNoOrder !== true) {
      throw new HttpError(
        422,
        "confirmation_required",
        "set confirmedNoOrder:true — only after the provider has confirmed that no order exists for this request id"
      );
    }
    try {
      return await swaps.forceRefund({ swapId: params[0], reason: String(body.reason ?? "admin:confirmed-no-order").slice(0, 32), actor: "admin" });
    } catch (err) {
      if (err instanceof LedgerError || err?.name === "InvalidSwap" || err?.name === "ProviderPending") {
        const plain = plainError(err);
        throw new HttpError(409, plain.code, plain.message);
      }
      throw err;
    }
  });

  route("POST", /^\/api\/admin\/stream-ticket$/, async ({ req }) => {
    requireRole(req, "admin");
    return { ticket: issueStreamTicket(), expiresInSeconds: STREAM_TICKET_TTL_MS / 1000 };
  });

  route("GET", /^\/api\/stream$/, async ({ req, res, url }) => {
    consumeStreamTicket(url);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", ledger: ledger.mode })}\n\n`);
    streams.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      streams.delete(res);
    });
    return null; // handled
  });

  // -------------------------------------------------------------- static

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir)) return json(res, 403, { error: "forbidden" });
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        if (!err && stat.isDirectory()) {
          res.writeHead(302, { location: url.pathname + "/" });
          return res.end();
        }
        return json(res, 404, { error: "not_found" });
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    });
  }

  // -------------------------------------------------------------- server

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = url.pathname.match(r.pattern);
        if (!match) continue;
        const body = req.method === "POST" ? await readBody(req) : {};
        const result = await r.handler({ req, res, url, params: match.slice(1), body });
        if (result === null) return; // the handler owns the response (SSE)
        return json(res, 200, result);
      }
      json(res, 404, { error: "not_found", message: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429 && err.extra?.retryAfterSeconds) res.setHeader("retry-after", String(err.extra.retryAfterSeconds));
        return json(res, err.status, { error: err.code, message: err.message, ...err.extra });
      }
      if (err instanceof PIIRefusedError) return json(res, 422, { error: "pii_refused", message: err.message });
      if (err?.name === "OpenLoopProductError") return json(res, 422, { error: "open_loop_refused", message: err.message });
      if (err instanceof LedgerError) {
        const plain = plainError(err);
        return json(res, 409, { error: plain.code, message: plain.message, revert: err.name });
      }
      store.log("service.error", { path: url.pathname, error: String(err?.message ?? err).slice(0, 200) });
      json(res, 500, { error: "internal", message: "something went wrong on the server" });
    }
  });

  return {
    server,
    ledger,
    store,
    provider,
    swaps,
    seed,
    enrollment: enrol,
    codeAttempts,
    tokens: { admin: adminToken, verifier: verifierToken },
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve({ port: server.address().port, url: `http://${host}:${server.address().port}` }));
      });
    },
    close() {
      for (const res of streams) res.end();
      streams.clear();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createApp, HttpError };

// -------------------------------------------------------------- main

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT ?? 8787);
    let providerUrl = process.env.PROVIDER_URL;
    let mock = null;
    if (!providerUrl) {
      mock = createMockProvider({ cert: process.env.PROVIDER_CERT });
      const listening = await mock.listen(Number(process.env.PROVIDER_PORT ?? 8788));
      providerUrl = listening.url;
      console.log(`mock gift card provider  ${providerUrl}   (separate listener)`);
    }
    const chosen = createLedger();
    const { ledger, fellBack, reason } = await verifyLedger(chosen);
    if (fellBack) console.warn(`chain unreachable, running the demo mirror instead — ${reason}`);
    const dataFile = process.env.DATA_FILE ?? (ledger.mode === "chain" ? path.join(__dirname, "..", ".data", "state.json") : null);
    const store = new Store({ file: dataFile });
    const app = createApp({ ledger, store, providerUrl });
    await app.seed();
    const { url } = await app.listen(port, process.env.HOST ?? "0.0.0.0");
    const base = `http://localhost:${port}`;
    console.log(`LanguageToken service      ${url}   ledger=${ledger.mode}${ledger.mode === "chain" ? ` @ ${ledger.deployment.address}` : ""}`);
    console.log(`  learner app              ${base}/learner/`);
    console.log(`  verifier console         ${base}/verifier/     token: ${app.tokens.verifier}`);
    console.log(`  admin console            ${base}/admin/        token: ${app.tokens.admin}`);
    console.log(`  demo stage (for a laptop)${base}/demo/`);
    console.log(`  public stats             ${base}/api/stats`);
    console.log(`  ledger                   ${ledger.mode === "chain" ? "on-chain (LanguageCredits)" : "demo mirror (JavaScript ledger — shown as such on every screen)"}`);
    console.log(
      `  participation codes      ${
        app.enrollment.required
          ? app.enrollment.demoCodes.length
            ? `${app.enrollment.demoCodes.length} demo codes: ${app.enrollment.demoCodes.slice(0, 3).join(", ")} … ${app.enrollment.demoCodes.at(-1)}`
            : `${app.enrollment.size} partner-issued codes loaded`
          : "OPEN — anyone can enrol (ENROLLMENT=open); the lifetime cap is per device, not per person"
      }`
    );
    console.log(`  coach                    ${assessment.liveCoachAvailable() ? "live (learner consent required)" : "offline (set COACH=live plus ANTHROPIC_API_KEY to enable)"}`);
    const shutdown = async () => {
      await app.close();
      if (mock) await mock.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}

// The learner app. One file, no framework, 430px.
//
// Flow: missions → practise three phrasings → coach → fixed check → result
//       → shop → swap → wallet → reveal (decrypted on this device only).
(function () {
  const { t, setLang, pick, LANGS } = window.LTi18n;
  const { ensureIdentity, saveToken, saveCode, openSealed } = window.LTCrypto;

  const $app = document.getElementById("app");
  const $nav = document.getElementById("nav");
  const $lang = document.getElementById("lang");
  const $toast = document.getElementById("toast");

  const state = { identity: null, token: null, handle: null, enrollment: null, enrollError: null, me: null, missions: [], catalog: [], wallet: [], screen: "home", mission: null, attempts: [], coach: null, answers: {}, result: null, revealed: {}, paused: false, coachMode: "offline" };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cad = (credits) => (credits / 20).toFixed(2);
  const LOCALES = { en: "en-CA", ko: "ko-KR", zh: "zh-CN" };
  const dateOf = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString(LOCALES[window.LTi18n.lang] ?? "en-CA", { year: "numeric", month: "short", day: "numeric" }) : "");

  // ---------------------------------------------------------------- api

  async function api(path, { method = "GET", body } = {}) {
    const headers = { "content-type": "application/json" };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error(t("offline"));
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/session") {
      await openSession(true); // the server restarted; re-attach with the same key
      return api(path, { method, body });
    }
    if (!res.ok) throw Object.assign(new Error(data.message || t("error")), { code: data.error, status: res.status });
    return data;
  }

  async function openSession(fresh = false, code = null) {
    state.identity = await ensureIdentity();
    const body = { publicKey: state.identity.publicJwk, language: window.LTi18n.lang };
    if (!fresh && state.identity.token) body.token = state.identity.token;
    const use = code ?? state.identity.code ?? null;
    if (use) body.enrollmentCode = use;
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw Object.assign(new Error(data.message ?? t("error")), { code: data.error });
    state.token = data.token;
    state.handle = data.handle;
    await saveToken(data.token);
    if (use && use !== state.identity.code) {
      await saveCode(use);
      state.identity.code = use;
    }
  }

  async function refresh() {
    const [me, missions, catalog, wallet] = await Promise.all([api("/api/me"), api("/api/missions"), api("/api/catalog"), api("/api/wallet")]);
    state.me = me;
    state.paused = me.paused;
    state.missions = missions.missions;
    state.coachMode = missions.coach;
    state.catalog = catalog.items;
    state.wallet = wallet.cards;
  }

  // ---------------------------------------------------------------- ui bits

  function toast(msg, kind = "red") {
    $toast.className = `toast notice ${kind}`;
    $toast.textContent = msg;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => $toast.classList.add("hidden"), 3500);
  }

  /** The badge that says, on every screen, which ledger this run is using. */
  function renderLedgerBadge() {
    const el = document.getElementById("ledger-badge");
    if (!el) return;
    const mode = state.me?.ledgerMode;
    if (!mode) return (el.className = "badge hidden");
    const chain = mode === "chain";
    el.className = `badge ${chain ? "green" : "amber"}`;
    el.textContent = chain ? t("ledger_onchain") : t("ledger_mirror");
    el.title = chain ? t("ledger_onchain_hint") : t("ledger_mirror_hint");
  }

  function renderNav() {
    const tabs = [
      ["home", "🏙️", t("nav_home")],
      ["shop", "🎁", t("nav_shop")],
      ["wallet", "👛", t("nav_wallet")],
    ];
    $nav.innerHTML = tabs.map(([id, ic, label]) => `<button data-go="${id}" class="${state.screen === id || (id === "home" && state.screen.startsWith("mission")) ? "active" : ""}"><span class="ic">${ic}</span>${esc(label)}</button>`).join("");
  }

  function balanceCard() {
    const me = state.me;
    const sub = state.paused ? t("paused") : me.balance > 0 ? t("balance_expires", { date: dateOf(me.expiresAt) }) : t("balance_none");
    return `<div class="balance"><div class="tiny" style="color:#fff;opacity:.85">${esc(t("balance_label"))}</div><div class="n">${me.balance}</div><div class="sub">${esc(t("balance_worth", { cad: cad(me.balance) }))} · ${esc(sub)}</div></div>`;
  }

  // ---------------------------------------------------------------- screens

  function renderHome() {
    const list = state.missions
      .map((m) => {
        const status = m.completed ? `<span class="badge green">${esc(t("mission_done"))}</span>` : m.pending ? `<span class="badge amber">${esc(t("mission_pending"))}</span>` : `<span class="badge blue">${esc(t("mission_reward", { n: m.reward }))}</span>`;
        return `<div class="card mission ${m.completed ? "done" : ""}" data-mission="${m.missionId}"><div class="ic">${m.icon}</div><div class="grow"><h3>${esc(pick(m.title))}</h3><div class="meta">${esc(pick(m.place))} · ${esc(t("mission_min", { n: m.minutes }))}</div></div>${status}</div>`;
      })
      .join("");
    return `${balanceCard()}<h2 style="margin-top:1.1rem">${esc(t("missions_title"))}</h2><div class="stack">${list}</div><p class="tiny" style="margin-top:1.2rem">${esc(t("footer"))}<br>${esc(t("handle"))}: <span class="mono">${esc(state.handle.slice(0, 10))}…</span></p>`;
  }

  function renderMissionIntro() {
    const m = state.mission;
    return `<div class="step"><b>1/4</b> ${esc(pick(m.title))}</div><div class="card"><div class="big">${m.icon}</div><h2 style="text-align:center">${esc(pick(m.title))}</h2><p class="muted" style="text-align:center">${esc(pick(m.scenario))}</p><dl class="kv"><dt>${esc(t("mission_place"))}</dt><dd>${esc(pick(m.place))}</dd><dt>${esc(t("mission_reward_label"))}</dt><dd>${esc(t("mission_reward", { n: m.reward }))}</dd></dl><button class="btn-primary btn-block" style="margin-top:1rem" data-go="mission-practise">${esc(t("mission_start", { n: m.minutes }))}</button></div>`;
  }

  function renderPractise() {
    const m = state.mission;
    const prompts = m.prompts.map((p, i) => `<div class="prompt" style="margin-top:.8rem"><label>${i + 1}. ${esc(pick(p.ask))}</label><textarea data-attempt="${i}" placeholder="…">${esc(state.attempts[i] ?? "")}</textarea></div>`).join("");
    return `<div class="step"><b>2/4</b> ${esc(t("practise_title"))}</div><div class="card"><p class="muted">${esc(t("practise_hint"))}</p>${prompts}<button class="btn-primary btn-block" style="margin-top:1rem" data-coach>${esc(t("practise_coach"))}</button><button class="btn-ghost btn-block btn-sm" style="margin-top:.4rem" data-go="mission-check">${esc(t("practise_skip"))}</button></div>`;
  }

  function renderCoach() {
    const c = state.coach;
    const corr = c.corrections.map((x) => `<div class="corr">${x.original ? `<div class="orig">${esc(x.original)}</div>` : ""}<div class="better">${esc(x.better)}</div><div class="why">${esc(x.why)}</div></div>`).join("");
    return `<div class="step"><b>3/4</b> ${esc(t("coach_title"))} <span class="badge">${esc(state.coachSource === "live" ? t("coach_live") : t("coach_offline"))}</span></div><div class="card"><div class="tiny" style="margin-bottom:.4rem">${esc(t("coach_more_natural"))}</div>${corr}<p style="margin-top:.8rem">${esc(c.explanation)}</p><p class="notice green">${esc(c.encouragement)}</p><p class="tiny">${esc(t("coach_note"))}</p><button class="btn-primary btn-block" data-go="mission-check">${esc(t("coach_next"))}</button></div>`;
  }

  function renderCheck() {
    const m = state.mission;
    const choices = m.criteria.filter((c) => c.type === "choice");
    const phrase = m.criteria.find((c) => c.type === "phrase");
    const qs = choices
      .map(
        (c, qi) => `<div style="margin-top:.9rem"><b>${qi + 1}. ${esc(c.prompt)}</b>${c.choices
          .map((ch, i) => `<label class="choice ${state.answers[c.id] === i ? "sel" : ""}"><input type="radio" name="${c.id}" value="${i}" ${state.answers[c.id] === i ? "checked" : ""}> <span>${esc(ch)}</span></label>`)
          .join("")}</div>`
      )
      .join("");
    return `<div class="step"><b>4/4</b> ${esc(t("check_title"))}</div><div class="card">${phrase ? `<p class="notice blue">${esc(t("check_phrase", { phrase: phrase.hint }))}</p>` : ""}${qs}<button class="btn-primary btn-block" style="margin-top:1rem" data-submit>${esc(t("check_submit"))}</button></div>`;
  }

  function renderResult() {
    const r = state.result;
    const m = state.mission;
    const crit = r.criteria.map((c) => `<div class="crit"><span class="mark">${c.met ? "✅" : "❌"}</span><span>${esc(pick(c.label))}</span></div>`).join("");
    let head;
    if (r.outcome === "passed") {
      head = `<div class="big">🎉</div><h2 style="text-align:center">${esc(t("result_passed"))}</h2>${r.awarded ? `<p class="notice green" style="text-align:center"><b>${esc(t("result_awarded", { n: r.awarded }))}</b></p>` : `<p class="notice amber">${esc(t("result_not_awarded"))} ${esc(r.notAwarded?.message ?? "")}</p>`}`;
    } else if (r.outcome === "review") {
      head = `<div class="big">🕵️</div><h2 style="text-align:center">${esc(t("result_review"))}</h2><p class="notice amber">${esc(t("result_review_body", { n: m.reward }))}</p>`;
    } else {
      head = `<div class="big">🙂</div><h2 style="text-align:center">${esc(t("result_failed"))}</h2><p class="notice">${esc(t("result_failed_body"))}</p>`;
    }
    return `<div class="card">${head}<div class="tiny" style="margin:.8rem 0 .3rem">${esc(t("result_criteria"))}</div>${crit}<div class="row" style="margin-top:1rem"><button class="grow" data-go="home">${esc(t("result_home"))}</button>${r.outcome === "passed" && r.awarded ? `<button class="btn-primary grow" data-go="shop">${esc(t("result_shop"))}</button>` : r.outcome === "failed" ? `<button class="btn-primary grow" data-go="mission-practise">${esc(t("practise_title"))}</button>` : ""}</div></div>`;
  }

  function renderShop() {
    const items = state.catalog
      .map((i) => {
        const can = i.active && i.inventory > 0 && state.me.balance >= i.cost && !state.paused;
        const stock = i.inventory > 0 ? t("shop_stock", { n: i.inventory }) : t("shop_out");
        const cta = i.inventory === 0 ? `<span class="badge red">${esc(t("shop_out"))}</span>` : state.me.balance < i.cost ? `<span class="badge amber">${esc(t("shop_need", { n: i.cost - state.me.balance }))}</span>` : `<button class="btn-primary btn-sm" data-swap="${i.itemId}" ${can ? "" : "disabled"}>${esc(t("shop_swap", { n: i.cost }))}</button>`;
        return `<div class="card item"><div class="ic">${i.icon}</div><div class="grow"><h3>${esc(i.brand)} · CAD ${i.valueCad}</h3><div class="meta">${esc(i.where)}<br>${i.cost} credits · ${esc(stock)}</div></div>${cta}</div>`;
      })
      .join("");
    return `${balanceCard()}<h2 style="margin-top:1.1rem">${esc(t("shop_title"))}</h2><p class="tiny">${esc(t("shop_sub"))}</p><div class="stack">${items}</div>`;
  }

  const giftClass = (slug) => (slug.startsWith("tim") ? "tim" : slug.startsWith("save") ? "saveon" : slug.startsWith("translink") ? "translink" : "maple");

  function renderWallet() {
    if (!state.wallet.length) return `<h2>${esc(t("wallet_title"))}</h2><p class="tiny">${esc(t("wallet_sub"))}</p><div class="card"><p class="muted" style="text-align:center;margin:1rem 0">${esc(t("wallet_empty"))}</p></div>`;
    const cards = state.wallet
      .map((c) => {
        const open = state.revealed[c.swapId];
        const number = open ? open.cardnbr.replace(/(\d{4})(?=\d)/g, "$1 ") : `•••• •••• •••• ${c.last4 ?? "····"}`;
        const status = c.status === "Settled" ? "" : `<span class="badge ${c.status === "Cancelled" ? "red" : "amber"}">${esc(c.status === "Cancelled" ? t("wallet_refunded") : t("wallet_processing"))}</span>`;
        const meta = open ? `<div class="meta"><span>${esc(t("wallet_pin"))} <b>${esc(open.pin)}</b></span><span>${esc(t("wallet_expiry"))} ${esc(open.expiry)}</span><span>${esc(t("wallet_order"))} ${esc(open.orderRef)}</span></div>` : `<div class="meta"><span>CAD ${c.valueCad}</span><span>${c.cost} credits</span></div>`;
        const tags = [c.recovered ? t("wallet_recovered") : null, c.reveals ? t("wallet_revealed", { n: c.reveals }) : null].filter(Boolean).join(" · ");
        return `<div class="gift ${giftClass(c.slug)}"><div class="brand-line"><span>${c.icon} ${esc(c.brand)}</span>${status}${c.status === "Settled" ? `<button class="btn-sm" data-reveal="${c.swapId}">${esc(open ? t("wallet_hide") : t("wallet_reveal"))}</button>` : ""}</div><div class="num">${esc(number)}</div>${meta}<div class="tag">🔒 ${esc(t("wallet_sub").split(".")[0])}${tags ? ` · ${esc(tags)}` : ""}</div></div>`;
      })
      .join("");
    return `<h2>${esc(t("wallet_title"))}</h2><p class="tiny">${esc(t("wallet_sub"))}</p>${cards}<p class="tiny" style="margin-top:1rem">${esc(t("wallet_warning"))}</p>`;
  }

  function render() {
    if (state.screen === "enrol") {
      $nav.innerHTML = "";
      $app.innerHTML = renderEnrol();
      renderLedgerBadge();
      document.getElementById("enrol-code")?.focus();
      return;
    }
    renderNav();
    const screens = { home: renderHome, mission: renderMissionIntro, "mission-practise": renderPractise, "mission-coach": renderCoach, "mission-check": renderCheck, "mission-result": renderResult, shop: renderShop, wallet: renderWallet };
    $app.innerHTML = (screens[state.screen] ?? renderHome)();
    renderLedgerBadge();
    window.scrollTo(0, 0);
  }

  function go(screen) {
    state.screen = screen;
    render();
  }

  // ---------------------------------------------------------------- actions

  async function startMission(missionId) {
    state.mission = state.missions.find((m) => m.missionId === missionId);
    state.attempts = [];
    state.coach = null;
    state.answers = {};
    state.result = null;
    go("mission");
  }

  function collectAttempts() {
    state.attempts = [...$app.querySelectorAll("[data-attempt]")].map((el) => el.value.trim());
  }

  async function askCoach() {
    collectAttempts();
    if (state.attempts.every((a) => !a)) return toast(t("practise_hint"), "amber");
    const allowExternalCoach = state.coachMode === "live" ? window.confirm(t("coach_consent")) : false;
    if (state.coachMode === "live" && !allowExternalCoach) return;
    const btn = $app.querySelector("[data-coach]");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${esc(t("practise_coach"))}`;
    try {
      const { feedback, source } = await api("/api/coach", { method: "POST", body: { missionId: state.mission.missionId, attempts: state.attempts, language: window.LTi18n.lang, allowExternalCoach } });
      state.coach = feedback;
      state.coachSource = source;
      go("mission-coach");
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = t("practise_coach");
    }
  }

  async function submit() {
    const choices = state.mission.criteria.filter((c) => c.type === "choice");
    if (choices.some((c) => state.answers[c.id] === undefined)) return toast(t("check_answer_all"), "amber");
    const btn = $app.querySelector("[data-submit]");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;
    try {
      state.result = await api("/api/submit", { method: "POST", body: { missionId: state.mission.missionId, answers: state.answers, attempts: state.attempts } });
      await refresh();
      go("mission-result");
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = t("check_submit");
    }
  }

  function confirmSwap(itemId) {
    const item = state.catalog.find((i) => i.itemId === itemId);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `<div class="sheet"><h2>${item.icon} ${esc(item.brand)} · CAD ${item.valueCad}</h2><p>${esc(t("shop_confirm", { cost: item.cost, brand: item.brand, value: item.valueCad }))}</p><div class="row"><button class="grow" data-no>${esc(t("shop_no"))}</button><button class="btn-primary grow" data-yes>${esc(t("shop_yes"))}</button></div></div>`;
    document.getElementById("phone").appendChild(overlay);
    overlay.querySelector("[data-no]").onclick = () => overlay.remove();
    overlay.querySelector("[data-yes]").onclick = () => {
      overlay.querySelector(".sheet").innerHTML = `<h2><span class="spinner"></span> ${esc(t("shop_processing"))}</h2><p class="muted">${esc(t("shop_processing_sub"))}</p>`;
      doSwap(item, overlay);
    };
  }

  async function doSwap(item, overlay) {
    try {
      const result = await api("/api/swap", { method: "POST", body: { itemId: item.itemId } });
      await refresh();
      if (result.status === "Settled") {
        overlay.querySelector(".sheet").innerHTML = `<div class="big">🎁</div><h2 style="text-align:center">${esc(t("shop_done"))}</h2><button class="btn-primary btn-block" data-open-wallet>${esc(t("shop_open_wallet"))}</button>`;
        overlay.querySelector("[data-open-wallet]").onclick = () => {
          overlay.remove();
          go("wallet");
        };
      } else {
        overlay.querySelector(".sheet").innerHTML = `<div class="big">↩️</div><p class="notice amber">${esc(t("shop_refunded", { n: item.cost }))}</p><button class="btn-block" data-close>OK</button>`;
        overlay.querySelector("[data-close]").onclick = () => {
          overlay.remove();
          go("shop");
        };
      }
    } catch (err) {
      overlay.remove();
      toast(err.message);
      await refresh().catch(() => {});
      render();
    }
  }

  async function reveal(swapId) {
    if (state.revealed[swapId]) {
      delete state.revealed[swapId];
      return render();
    }
    try {
      const card = await api(`/api/wallet/${swapId}/reveal`, { method: "POST" }); // counted and logged server-side
      const plain = await openSealed(card.sealed, state.identity.privateKey); // decrypted here, on this device
      state.revealed[swapId] = plain;
      await refresh();
      render();
      setTimeout(() => {
        if (state.revealed[swapId]) {
          delete state.revealed[swapId];
          if (state.screen === "wallet") render();
        }
      }, 45000);
    } catch (err) {
      toast(err.message);
    }
  }

  function renderEnrol() {
    const demo = (state.enrollment?.demoCodes ?? []).slice(0, 4);
    const hint = demo.length ? `<p class="tiny">${esc(t("enrol_demo"))} <span class="mono">${demo.map(esc).join("</span> · <span class=\"mono\">")}</span></p>` : "";
    const err = state.enrollError ? `<p class="notice red">${esc(state.enrollError)}</p>` : "";
    return `<div class="card"><div class="big">🎫</div><h2 style="text-align:center">${esc(t("enrol_title"))}</h2><p class="muted">${esc(t("enrol_body"))}</p>${err}<input id="enrol-code" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="${esc(t("enrol_placeholder"))}" value="${esc(state.enrolDraft ?? "")}"><button class="btn-primary btn-block" style="margin-top:.8rem" data-enrol>${esc(t("enrol_submit"))}</button>${hint}<p class="tiny">${esc(t("enrol_privacy"))}</p></div>`;
  }

  async function submitEnrol() {
    const input = document.getElementById("enrol-code");
    const code = (input?.value ?? "").trim();
    state.enrolDraft = code;
    if (!code) return toast(t("enrol_placeholder"), "amber");
    state.enrollError = null;
    try {
      await openSession(true, code);
      await refresh();
      state.screen = "home";
      render();
    } catch (err) {
      state.enrollError = err.code === "enrollment_invalid" ? t("enrol_invalid") : err.message;
      render();
    }
  }

  // ---------------------------------------------------------------- events

  $app.addEventListener("click", (e) => {
    const go_ = e.target.closest("[data-go]");
    if (go_) return go(go_.dataset.go);
    const m = e.target.closest("[data-mission]");
    if (m) return startMission(m.dataset.mission);
    if (e.target.closest("[data-coach]")) return askCoach();
    if (e.target.closest("[data-submit]")) return submit();
    const s = e.target.closest("[data-swap]");
    if (s) return confirmSwap(s.dataset.swap);
    const r = e.target.closest("[data-reveal]");
    if (r) return reveal(Number(r.dataset.reveal));
    if (e.target.closest("[data-enrol]")) return submitEnrol();
  });
  $app.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "enrol-code") {
      e.preventDefault();
      submitEnrol();
    }
  });
  $app.addEventListener("change", (e) => {
    if (e.target.type === "radio") {
      state.answers[e.target.name] = Number(e.target.value);
      render();
    }
  });
  $app.addEventListener("input", (e) => {
    if (e.target.matches("[data-attempt]")) state.attempts[Number(e.target.dataset.attempt)] = e.target.value;
  });
  $nav.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    try {
      await refresh();
    } catch {
      /* show what we have */
    }
    go(b.dataset.go);
  });
  $lang.innerHTML = LANGS.map((l) => `<option value="${l.code}" ${l.code === window.LTi18n.lang ? "selected" : ""}>${l.label}</option>`).join("");
  $lang.addEventListener("change", () => {
    setLang($lang.value);
    api("/api/session", { method: "POST", body: { token: state.token, language: $lang.value } }).catch(() => {});
    render();
  });

  // ---------------------------------------------------------------- boot

  (async () => {
    try {
      state.enrollment = await fetch("/api/enrollment").then((r) => r.json()).catch(() => ({ required: false, demoCodes: [] }));
      try {
        await openSession();
      } catch (err) {
        if (err.code !== "enrollment_required" && err.code !== "enrollment_invalid") throw err;
        state.enrollError = err.code === "enrollment_invalid" ? t("enrol_invalid") : null;
        state.screen = "enrol";
        return render();
      }
      await refresh();
      render();
    } catch (err) {
      $app.innerHTML = `<p class="notice red">${esc(err.message)}</p>`;
    }
  })();
})();

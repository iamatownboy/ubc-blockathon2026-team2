// The admin console. Missions, catalog, pause, the live ledger event stream,
// the service log, and the provider failure switches for the demo.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $token = $("token");
  $token.value = localStorage.getItem("languagetoken.adminToken") || "admin-demo";
  /** Say plainly when the published demo token is the one in use. */
  const flagDemoToken = () => $("demo-warn").classList.toggle("hidden", $token.value !== "admin-demo");
  flagDemoToken();
  $token.addEventListener("change", () => {
    localStorage.setItem("languagetoken.adminToken", $token.value);
    flagDemoToken();
    connectStream();
    load();
  });

  async function api(path, method = "GET", body) {
    const res = await fetch(path, { method, headers: { "content-type": "application/json", "x-role-token": $token.value }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || res.status);
    return data;
  }

  // A bytes32 that is really a short ASCII string (productCode, cancel reason) is shown as text.
  const asciiOf = (hex) => {
    const bytes = hex.slice(2).match(/../g).map((h) => parseInt(h, 16));
    const end = bytes.indexOf(0);
    const body = end === -1 ? bytes : bytes.slice(0, end);
    if (!body.length || bytes.slice(body.length).some((b) => b !== 0) || body.some((b) => b < 0x20 || b > 0x7e)) return null;
    return String.fromCharCode(...body);
  };
  const fmt = (v) => (typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) ? asciiOf(v) ?? v.slice(0, 10) + "…" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const line = (cls, text) => {
    const el = document.createElement("div");
    el.className = `line ${cls}`;
    el.textContent = text;
    return el;
  };
  function push($log, el) {
    $log.appendChild(el);
    while ($log.children.length > 300) $log.removeChild($log.firstChild);
    $log.scrollTop = $log.scrollHeight;
  }
  const eventText = (e) => `${e.name}  ${Object.entries(e.args).map(([k, v]) => `${k}=${fmt(v)}`).join("  ")}`;
  const logText = (e) => `${e.at.slice(11, 19)}  ${e.event}  ${Object.entries(e).filter(([k]) => k !== "at" && k !== "event").map(([k, v]) => `${k}=${fmt(v)}`).join("  ")}`;

  // ---------------------------------------------------------------- render

  function render(s) {
    $("conn").textContent = "connected";
    $("conn").className = "badge green";
    const L = s.ledger;
    $("stats").innerHTML = [["awarded", L.awarded], ["outstanding", L.outstanding], ["in swap", L.inSwap], ["swapped", L.swapped], ["expired", L.expired], ["learners", s.learners], ["reviews", s.reviews], ["coach", s.coach]]
      .map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
      .join("");
    $("limits").textContent = `Limits the admin cannot raise: MAX_MISSION_REWARD ${s.limits.maxMissionReward} · LIFETIME_CAP ${s.limits.lifetimeCap} · CREDIT_TTL ${s.limits.creditTtlDays} days · conservation: ${L.awarded} = ${L.outstanding} + ${L.inSwap} + ${L.swapped} + ${L.expired}`;
    $("paused").textContent = s.paused ? "PAUSED" : "running";
    $("paused").className = `badge ${s.paused ? "red" : "green"}`;
    $("ledger-mode").textContent = L.mode + (L.address ? ` · ${L.address.slice(0, 10)}…` : "");

    $("missions").querySelector("tbody").innerHTML = s.missions
      .map((m) => `<tr data-mission="${m.missionId}"><td class="code" title="${esc(m.title)}">${m.icon} ${esc(m.slug)}</td><td><input type="number" min="1" max="${s.limits.maxMissionReward}" value="${m.reward}" data-f="reward"></td><td>v${m.version} <button class="btn-sm" data-bump>bump</button></td><td><span class="${m.active ? "pill-on" : "pill-off"}">${m.active ? "active" : "off"}</span></td><td class="actions"><button class="btn-sm" data-save-mission>save</button> <button class="btn-sm" data-toggle-mission>${m.active ? "deactivate" : "activate"}</button></td></tr>`)
      .join("");

    $("catalog").querySelector("tbody").innerHTML = s.catalog
      .map((i) => `<tr data-item="${i.itemId}"><td>${i.icon} ${esc(i.brand)} CAD ${i.valueCad}</td><td class="mono code">${esc(i.productCode)}</td><td><input type="number" min="1" value="${i.cost}" data-f="cost"></td><td><input type="number" min="0" value="${i.inventory}" data-f="inventory"></td><td><span class="${i.active ? "pill-on" : "pill-off"}">${i.active ? "active" : "off"}</span></td><td class="actions"><button class="btn-sm" data-save-item>save</button> <button class="btn-sm" data-toggle-item>${i.active ? "deactivate" : "activate"}</button></td></tr>`)
      .join("");

    $("roles").querySelector("tbody").innerHTML = s.roles.map((r) => `<tr><td class="mono">${esc(r.role)}</td><td>${esc(r.heldBy)}</td><td>${esc(r.can)}</td></tr>`).join("");

    $("swaps").querySelector("tbody").innerHTML = s.swaps.length
      ? s.swaps
          .map((w) => `<tr><td>${w.swapId}</td><td><span class="badge ${w.status === "Settled" ? "green" : w.status === "Cancelled" ? "red" : "amber"}">${w.status}</span></td><td>${esc(w.brand)}</td><td>${w.cost}</td><td>${w.last4 ? `•••• ${w.last4}` : "—"}</td><td class="mono">${esc(w.orderRef ?? "—")}</td><td>${w.reveals}</td><td class="tiny">${w.recovered ? "recovered after ghost/timeout" : ""}${w.reason ? esc(w.reason) : ""}</td><td>${w.status === "Requested" ? `<button class="btn-danger btn-sm" data-cancel="${w.swapId}">cancel + refund</button>` : ""}</td></tr>`)
          .join("")
      : `<tr><td colspan="9" class="muted">No swaps yet.</td></tr>`;

    renderProvider(s.provider);
  }

  function renderProvider(p) {
    if (!p || p.error) {
      $("provider-mode").textContent = "unreachable";
      return;
    }
    $("provider-mode").textContent = `${p.mode}${p.mode !== "normal" && p.once ? " (one-shot)" : ""} · ${p.orders} orders · ${p.cards} cards`;
    $("provider-mode").className = `badge ${p.mode === "normal" ? "green" : "red"}`;
    $("modes").innerHTML = p.modes.map((m) => `<button class="btn-sm ${p.mode === m ? "armed" : ""}" data-mode="${m}">${m}</button>`).join("");
    const $pl = $("provider-log");
    $pl.innerHTML = "";
    for (const e of p.log.slice(-40)) push($pl, line(e.event.includes("ghost") || e.event.includes("fail") || e.event.includes("hung") ? "er" : "lg", logText(e)));
  }

  async function load() {
    try {
      render(await api("/api/admin/state"));
    } catch (err) {
      $("conn").textContent = String(err.message);
      $("conn").className = "badge red";
    }
  }

  // ---------------------------------------------------------------- stream

  let es = null;
  function connectStream() {
    if (es) es.close();
    es = new EventSource(`/api/stream?token=${encodeURIComponent($token.value)}`);
    es.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "ledger") {
        push($("events"), line("ev", eventText(data.event)));
        load();
      } else if (data.type === "log") {
        push($("service-log"), line(data.entry.event.includes("error") ? "er" : "lg", logText(data.entry)));
        if (/swap|provider|mission|admin/.test(data.entry.event)) load();
      }
    };
    es.onerror = () => {
      $("conn").textContent = "stream lost — retrying";
      $("conn").className = "badge amber";
    };
  }

  async function backfill() {
    try {
      const { events } = await api("/api/events");
      for (const e of events.slice(-100)) push($("events"), line("ev", eventText(e)));
      const { log } = await api("/api/admin/log");
      for (const e of log.slice(-100)) push($("service-log"), line("lg", logText(e)));
    } catch {
      /* not authorised yet */
    }
  }

  // ---------------------------------------------------------------- actions

  const guard = (fn) => async (...a) => {
    try {
      await fn(...a);
    } catch (err) {
      alert(err.message);
    }
    load();
  };

  $("pause").onclick = guard(() => api("/api/admin/pause", "POST", {}));
  $("sync").onclick = guard(async () => {
    const r = await api("/api/admin/catalog/sync", "POST", {});
    const listed = r.accepted.filter((p) => p.listed);
    const unlisted = r.accepted.filter((p) => !p.listed);
    $("sync-result").innerHTML =
      `fetched ${r.fetched} · on our list ${listed.length}` +
      `${unlisted.length ? ` · <b>not approved ${unlisted.length}</b>${unlisted.map((x) => ` — ${esc(x.productCode)}`).join("")}` : ""}` +
      ` · <b style="color:var(--accent)">refused ${r.refused.length}</b>${r.refused.map((x) => ` — ${esc(x.productCode)} (${esc(x.brand)}): open loop`).join("")}`;
  });
  $("unpause").onclick = guard(() => api("/api/admin/unpause", "POST", {}));
  $("modes").addEventListener("click", guard(async (e) => {
    const b = e.target.closest("[data-mode]");
    if (b) await api("/api/admin/provider/mode", "POST", { mode: b.dataset.mode, once: $("once").checked });
  }));
  $("missions").addEventListener("click", guard(async (e) => {
    const tr = e.target.closest("tr[data-mission]");
    if (!tr) return;
    const missionId = tr.dataset.mission;
    if (e.target.closest("[data-save-mission]")) await api("/api/admin/missions", "POST", { missionId, reward: Number(tr.querySelector('[data-f="reward"]').value) });
    if (e.target.closest("[data-bump]")) {
      const { mission } = await api("/api/admin/missions", "POST", { missionId });
      await api("/api/admin/missions", "POST", { missionId, version: mission.version + 1 });
    }
    if (e.target.closest("[data-toggle-mission]")) {
      const { mission } = await api("/api/admin/missions", "POST", { missionId });
      await api("/api/admin/missions", "POST", { missionId, active: !mission.active });
    }
  }));
  $("catalog").addEventListener("click", guard(async (e) => {
    const tr = e.target.closest("tr[data-item]");
    if (!tr) return;
    const itemId = tr.dataset.item;
    if (e.target.closest("[data-save-item]")) await api("/api/admin/catalog", "POST", { itemId, cost: Number(tr.querySelector('[data-f="cost"]').value), inventory: Number(tr.querySelector('[data-f="inventory"]').value) });
    if (e.target.closest("[data-toggle-item]")) {
      const { item } = await api("/api/admin/catalog", "POST", { itemId });
      await api("/api/admin/catalog", "POST", { itemId, active: !item.active });
    }
  }));
  $("swaps").addEventListener("click", guard(async (e) => {
    const b = e.target.closest("[data-cancel]");
    if (b && confirm(`Cancel swap #${b.dataset.cancel} and refund the learner?`)) await api(`/api/admin/swaps/${b.dataset.cancel}/cancel`, "POST", { reason: "admin:console" });
  }));

  load();
  backfill();
  connectStream();
  setInterval(load, 5000);
})();

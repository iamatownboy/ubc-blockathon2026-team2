// The demo stage. A laptop-sized view of the learner phone with the ledger
// beside it, so a judge can watch a credit being awarded on one side and the
// event landing on the other.
//
// It reads only the two endpoints that need no token — /api/stats and
// /api/events — so the presentation screen never carries an admin secret.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (v) => (typeof v === "string" && /^0x[0-9a-f]{40,}$/i.test(v) ? v.slice(0, 10) + "…" : v);
  const seen = new Set();
  let first = true;

  const TILES = [
    ["awarded", "Awarded"],
    ["outstanding", "Outstanding"],
    ["inSwap", "In swap"],
    ["swapped", "Swapped"],
    ["expired", "Expired"],
  ];

  function renderLedgerBadge(stats) {
    const chain = stats.ledger.mode === "chain";
    for (const id of ["ledger", "ledger2"]) {
      const el = $(id);
      el.textContent = chain ? "On-chain" : "Demo mirror";
      el.className = `badge ${chain ? "green" : "amber"}`;
      el.title = chain
        ? "Every award, swap and refund below is a transaction on the LanguageCredits contract."
        : "This run uses the JavaScript mirror of the contract, not a chain. Same rules, no transactions.";
    }
    if (chain && stats.ledger.address) {
      $("addr").style.display = "";
      $("addr").textContent = stats.ledger.address.slice(0, 12) + "…";
    } else {
      $("addr").style.display = "none";
    }
  }

  function renderTiles(l) {
    $("tiles").innerHTML = TILES.map(([k, label]) => `<div class="stat"><div class="k">${label}</div><div class="v">${l[k] ?? 0}</div></div>`).join("");
    const sum = (l.outstanding ?? 0) + (l.inSwap ?? 0) + (l.swapped ?? 0) + (l.expired ?? 0);
    const ok = sum === (l.awarded ?? 0);
    $("conserve").innerHTML = `<span class="badge ${ok ? "green" : "red"}">${ok ? "balanced" : "MISMATCH"}</span><span class="muted">awarded ${l.awarded ?? 0} = outstanding + in-swap + swapped + expired (${sum})</span>`;
  }

  function renderStock(items) {
    $("stock").innerHTML = items
      .map((i) => `<span class="badge ${i.inventory > 0 ? "blue" : "red"}">${esc(i.brand)} · ${i.cost} cr · ${i.inventory > 0 ? i.inventory + " left" : "sold out"}</span>`)
      .join("");
  }

  function renderEvents(events) {
    const box = $("events");
    const fresh = events.filter((e) => !seen.has(String(e.seq)));
    if (!fresh.length) return;
    if (first) box.innerHTML = "";
    for (const e of fresh) {
      seen.add(String(e.seq));
      const args = Object.entries(e.args ?? {})
        .filter(([k]) => k !== "proofHash" && k !== "requestHash")
        .map(([k, v]) => `${k}=${esc(String(short(v)))}`)
        .join(" ");
      const row = document.createElement("div");
      row.className = `row${first ? "" : " fresh"}`;
      row.innerHTML = `<span class="nm">${esc(e.name)}</span><span class="dt">${args}</span>`;
      box.prepend(row);
    }
    first = false;
    while (box.children.length > 120) box.lastChild.remove();
  }

  async function tick() {
    try {
      const [stats, events] = await Promise.all([
        fetch("/api/stats").then((r) => r.json()),
        fetch("/api/events").then((r) => r.json()),
      ]);
      renderLedgerBadge(stats);
      renderTiles(stats.ledger);
      renderStock(stats.catalog);
      renderEvents(events.events);
      $("conn").textContent = `${stats.learners} session${stats.learners === 1 ? "" : "s"} · ${stats.reviews.pending} awaiting review · updated ${new Date().toLocaleTimeString()}`;
    } catch {
      $("conn").textContent = "service unreachable";
    }
  }

  fetch("/api/enrollment")
    .then((r) => r.json())
    .then((e) => {
      $("codes").textContent = e.demoCodes?.length ? e.demoCodes.slice(0, 6).join("  ") + (e.demoCodes.length > 6 ? " …" : "") : "issued by the partner desk (not shown here)";
    })
    .catch(() => {});

  tick();
  setInterval(tick, 1500);
})();

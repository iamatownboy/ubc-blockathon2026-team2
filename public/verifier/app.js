// The verifier console: the review queue. No amount field — approving pays
// whatever the mission registry says, and nothing this page sends can
// change that.
(function () {
  const $ = (id) => document.getElementById(id);
  const $token = document.getElementById("token");
  const $queue = document.getElementById("queue");
  const $conn = document.getElementById("conn");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  $token.value = localStorage.getItem("languagetoken.verifierToken") || "verifier-demo";
  /** Say plainly when the published demo token is the one in use. */
  const flagDemoToken = () => $("demo-warn").classList.toggle("hidden", $token.value !== "verifier-demo");
  flagDemoToken();
  $token.addEventListener("change", () => {
    localStorage.setItem("languagetoken.verifierToken", $token.value);
    flagDemoToken();
    load();
  });

  async function api(path, method = "GET", body) {
    const res = await fetch(path, { method, headers: { "content-type": "application/json", "x-role-token": $token.value }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || res.status);
    return data;
  }

  function renderReview(r) {
    const crit = r.criteria.map((c) => `<div class="crit">${c.met ? "✅" : "❌"} <span>${esc(c.label)}</span></div>`).join("");
    const contentRemoved = !Array.isArray(r.attempts) || !r.answers;
    const attempts = contentRemoved
      ? `<div class="attempt muted">Learner-written content removed after review.</div>`
      : r.attempts.map((a, i) => `<div class="attempt">${i + 1}. ${esc(a || "—")}</div>`).join("");
    const answers = contentRemoved
      ? `<div class="answer muted">Answers removed after review.</div>`
      : r.choices.map((q) => { const chosen = r.answers[q.id]; return `<div class="answer"><b>${esc(q.prompt)}</b><br>→ ${chosen === undefined ? "—" : esc(q.choices[chosen])}</div>`; }).join("");
    const decided = r.status !== "pending";
    const actions = decided
      ? `<span class="badge ${r.status === "approved" ? "green" : "red"}">${r.status}${r.awarded ? ` · +${r.awarded}` : ""}</span>`
      : `<div class="row"><button class="btn-primary btn-sm" data-approve="${r.id}">Approve → award ${r.configuredReward} credits</button><button class="btn-danger btn-sm" data-reject="${r.id}">Reject</button></div>`;
    return `<div class="card review ${decided ? "decided" : ""}"><div class="row between wrap"><div><h3 style="margin:0">${esc(r.title)}</h3><div class="tiny">handle <span class="mono">${esc(r.handle.slice(0, 14))}…</span> · ${new Date(r.at).toLocaleTimeString()} · missed: <b>${esc(r.missed.join(", "))}</b></div></div>${actions}</div><div class="grid" style="margin-top:.6rem"><div><div class="tiny">Fixed criteria</div>${crit}</div><div><div class="tiny">What the learner wrote</div>${attempts}</div><div><div class="tiny">Multiple choice</div>${answers}</div></div></div>`;
  }

  async function load() {
    try {
      const { queue } = await api("/api/verifier/queue");
      $conn.textContent = "connected";
      $conn.className = "badge green";
      const pending = queue.filter((r) => r.status === "pending");
      document.getElementById("n-pending").textContent = pending.length;
      document.getElementById("n-decided").textContent = queue.length - pending.length;
      $queue.innerHTML = queue.length ? queue.map(renderReview).join("") : `<div class="card"><p class="muted">The queue is empty. A submission lands here when it misses exactly one criterion.</p></div>`;
    } catch (err) {
      $conn.textContent = String(err.message);
      $conn.className = "badge red";
    }
  }

  $queue.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-approve]");
    const r = e.target.closest("[data-reject]");
    if (!a && !r) return;
    const id = (a || r).dataset.approve || (a || r).dataset.reject;
    (a || r).disabled = true;
    try {
      await api(`/api/verifier/queue/${id}/${a ? "approve" : "reject"}`, "POST", {}); // note: no amount in the body, by design
    } catch (err) {
      alert(err.message);
    }
    load();
  });

  document.getElementById("refresh").onclick = load;
  load();
  setInterval(load, 3000);
})();

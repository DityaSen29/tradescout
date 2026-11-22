/* TradeScout desk: a thin client over the API. No build step. */
const $ = (s, el = document) => el.querySelector(s);
const STEPS = [["parse", "Read the request"], ["search", "Find counterparties"], ["vet", "Vet them"], ["intent", "Buying signals"], ["contacts", "Find the buyer"], ["draft", "Draft the note"], ["report", "Write the report"]];
let current = null, es = null, pollTimer = null;

const fmtCredits = (n) => (Math.round((n ?? 0) * 100) / 100).toString();
const fmtMs = (ms) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const when = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} on ${path}`);
  return body;
}

async function health() {
  try { await api("/health"); $("#api-state").textContent = "api live"; $("#api-state").className = "pill live"; }
  catch { $("#api-state").textContent = "api unreachable"; $("#api-state").className = "pill bad"; }
}

async function loadRuns() {
  const runs = await api("/runs");
  const ul = $("#run-list"); ul.innerHTML = "";
  if (!runs.length) ul.innerHTML = `<li class="r-empty">No runs yet.</li>`;
  for (const r of runs) {
    const li = document.createElement("li");
    li.className = r.id === current ? "active" : "";
    li.innerHTML = `<span>${esc(r.request.product)} → ${esc(r.request.target_country)}<br><small>${when(r.created_at)} · ${fmtCredits(r.totals.credits_used)} cr</small></span><span class="r-status">${esc(r.status)}</span>`;
    li.onclick = () => openRun(r.id);
    ul.appendChild(li);
  }
}

function renderSteps(steps, liveState = {}) {
  const ol = $("#steps"); ol.innerHTML = "";
  const byName = Object.fromEntries((steps || []).map(s => [s.name, s]));
  for (const [name, label] of STEPS) {
    const s = byName[name]; const live = liveState[name];
    let cls = live || (s ? (s.status === "done" ? (s.attempts > 1 ? "done" : "done") : s.status === "running" ? "running" : s.status === "failed" ? "fail" : "") : "");
    const out = s && s.status === "done" ? "" : "";
    const li = document.createElement("li"); li.className = cls;
    li.innerHTML = `${esc(label)}<small>${s ? (s.status === "done" ? `done${s.attempts > 1 ? `, attempt ${s.attempts}` : ""}` : s.status === "failed" ? "failed" : s.status) : (live || "waiting")}${out}</small>`;
    ol.appendChild(li);
  }
}

function layerBox(title, layer, render) {
  if (!layer) return `<div class="layer"><h3>${title}</h3><p class="state">not run</p></div>`;
  if (layer.status !== "ok") return `<div class="layer"><h3>${title}</h3><p class="state">${esc(layer.status === "cannot_verify" ? "cannot verify" : "unavailable")}${layer.reason ? `: ${esc(layer.reason)}` : ""}</p></div>`;
  return `<div class="layer"><h3>${title}</h3>${render(layer)}</div>`;
}

function renderReport(d) {
  const r = d.report;
  $("#request-line").textContent = `${d.run.request.product} for ${d.run.request.target_country}, ${d.run.request.min_headcount} to ${d.run.request.max_headcount} staff`;
  $("#resolved").textContent = r?.resolved ? `Read as HS ${r.resolved.hs_code ?? "?"}${r.resolved.hs_text ? ` (${r.resolved.hs_text})` : ""} in ${r.resolved.country_iso3 ?? "?"}; search language: ${(r.resolved.keywords || []).slice(0, 4).join(", ")}` : "";
  const st = $("#run-status"); st.textContent = d.running ? "running" : d.run.status; st.className = `pill ${d.run.status === "done" ? "live" : d.run.status === "failed" || d.run.status === "budget_exceeded" ? "bad" : ""}`;
  $("#resume-btn").hidden = d.running || !(d.run.status === "failed" || d.run.status === "running");
  $("#rerun-btn").hidden = d.run.status !== "done";
  renderSteps(d.steps);

  // layers
  $("#layers").innerHTML = [
    layerBox("Market", r?.market, (l) => `<p>${esc(l.data?.summary ?? "")}</p>`),
    layerBox("Duty and policy", r?.tariff ?? r?.policy, (l) => `<p>${esc(l.data?.summary ?? "")}</p>`),
    layerBox("Since last run", r?.monitor, (l) => l.data.changes.length ? `<ul>${l.data.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : `<p>No change since ${when(l.data.since)}.</p>`),
  ].join("");

  // shortlist
  const box = $("#shortlist"); box.innerHTML = "";
  const cands = r?.candidates || [];
  $("#shortlist-title").textContent = cands.length ? `Shortlist, ${cands.length} counterparties` : "Shortlist";
  if (!cands.length) box.innerHTML = `<p class="notice">${d.run.status === "done" ? "No counterparties matched. Try a wider staff range or a different wording of the product." : "Nothing yet. The shortlist fills in when the report step finishes."}</p>`;
  const tpl = $("#candidate-row");
  cands.forEach((c, i) => {
    const n = tpl.content.cloneNode(true);
    $(".rank", n).textContent = i + 1;
    $(".name", n).textContent = c.name;
    $(".meta", n).textContent = [c.domain, c.city || c.country, c.headcount != null ? `${c.headcount} staff` : null, c.year_founded ? `since ${c.year_founded}` : null].filter(Boolean).join(" · ");
    $(".why", n).textContent = `${c.fit_reasons.slice(0, 3).join("; ")}${c.trust_reasons.length ? `. Trust: ${c.trust_reasons.slice(0, 2).join("; ")}` : ""}`;
    const ct = $(".contact", n);
    if (c.contact) ct.textContent = `Buyer: ${c.contact.name}, ${c.contact.title}`; else { ct.textContent = c.unresolved[0] ? `Needs a person: ${c.unresolved[0]}` : "No contact looked up (not vetted)"; ct.classList.add("missing"); }
    const ev = $(".evidence", n); $("summary", ev).textContent = `${c.evidence.length} sources`;
    $("ul", ev).innerHTML = c.evidence.map(e => `<li>${esc(e.claim)} <a href="${esc(e.source_url)}" target="_blank" rel="noopener">${esc(e.source_type)}${e.record_id ? ` #${esc(e.record_id)}` : ""}${e.field ? ` · ${esc(e.field)}` : ""}</a> <span class="state">${e.record_date ? `dated ${esc(e.record_date)}` : `retrieved ${when(e.retrieved_at)}`}</span></li>`).join("");
    const stamp = $(".stamp", n); stamp.textContent = c.trust_tier; stamp.classList.add(c.trust_tier);
    $(".fit i", n).style.width = `${c.fit_score}%`; $(".fit .num", n).textContent = `fit ${c.fit_score}`;
    $(".intent", n).textContent = c.intent_tags.length ? `Signals: ${c.intent_tags.join("; ")}` : "";
    box.appendChild(n);
  });

  // needs a person
  const np = $("#needs-person");
  const items = r?.unresolved || [];
  np.innerHTML = items.length ? `<h2>Needs a person, ${items.length}</h2><ul>${items.map(u => `<li>${esc(u)}</li>`).join("")}</ul>` : "";
  if (r?.limitations?.length) np.innerHTML += `<details><summary>What this run does not do</summary><ul>${r.limitations.map(l => `<li>${esc(l)}</li>`).join("")}</ul></details>`;

  // ledger
  const t = d.totals; const run = d.run;
  const elapsed = r?.ledger?.elapsed_ms;
  $("#ledger").innerHTML = `<dt>Crustdata credits</dt><dd>${fmtCredits(t.credits_used)} of ${run.credit_limit}</dd><dt>Model cost</dt><dd>$${(t.model_cost_usd || 0).toFixed(3)}</dd><dt>Calls</dt><dd>${t.calls}</dd><dt>Active time</dt><dd>${elapsed != null ? fmtMs(elapsed) : "running"} of ${fmtMs(run.time_limit_ms)}</dd><dt>Checkpoints</dt><dd>${(d.steps || []).filter(s => s.status === "done").length} of ${STEPS.length}</dd>`;
  api(`/runs/${d.run.id}/ledger`).then(l => {
    $("#calls").innerHTML = l.calls.map(c => `<tr><td>${esc(c.step)}<br><small>${esc(c.source)} ${esc(c.endpoint)}${c.status === "cached" ? " (memo)" : c.status === "error" ? " (error)" : ""}</small></td><td>${fmtCredits(c.credits)} cr<br><small>${fmtMs(c.latency_ms)}</small></td></tr>`).join("");
  }).catch(() => {});

  // actions
  const ab = $("#actions"); ab.innerHTML = "";
  const acts = (d.actions || []).filter(a => a.kind === "email_draft");
  if (!acts.length) ab.innerHTML = `<p class="state">${d.run.status === "done" ? "No drafts: no vetted counterparty had a reachable buyer." : "Drafts appear after the draft step."}</p>`;
  for (const a of acts) {
    const div = document.createElement("div"); div.className = `action ${a.status}`;
    div.innerHTML = `<p class="to">${esc(a.payload.to_name)}, ${esc(a.payload.to_title)} at ${esc(a.payload.company)}</p><p class="state">${esc(a.status)}${a.executed_at ? ` at ${when(a.executed_at)}` : ""}</p><div class="body">${esc(a.payload.body)}</div><div class="btns"></div>`;
    const btns = $(".btns", div);
    if (a.status === "proposed") btns.innerHTML = `<button data-v="approve">Approve</button><button data-v="reject" class="ghost">Reject</button>`;
    if (a.status === "approved") btns.innerHTML = `<button data-v="execute">Write the .eml file</button>`;
    if (a.status === "executed") btns.innerHTML = `<span class="state">Written once to data/out. Sending stays with you.</span>`;
    btns.onclick = async (e) => { const v = e.target.dataset.v; if (!v) return; e.target.disabled = true; try { await api(`/actions/${a.id}/${v}`, { method: "POST" }); } catch (err) { alert(err.message); } openRun(current); };
    ab.appendChild(div);
  }

  // monitor rail
  const m = $("#monitor");
  m.innerHTML = r?.monitor?.status === "ok" ? `<h2>Since ${when(r.monitor.data.since)}</h2>${r.monitor.data.changes.length ? `<ul>${r.monitor.data.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : "<p>No change.</p>"}` : "";
}

async function openRun(id) {
  current = id; if (es) { es.close(); es = null; } clearTimeout(pollTimer);
  $("#empty").hidden = true; $("#sheet").hidden = false;
  const d = await api(`/runs/${id}`);
  renderReport(d); loadRuns();
  if (d.running || d.run.status === "running") follow(id);
}

function follow(id) {
  const liveState = {};
  es = new EventSource(`/api/runs/${id}/events`);
  es.addEventListener("step", (ev) => {
    const e = JSON.parse(ev.data);
    liveState[e.name] = e.status === "start" ? "running" : e.status === "done" ? "done" : e.status === "skip" ? "reused" : e.status === "unavailable" ? "unavailable" : e.status === "fail" ? "fail" : "";
    const ol = $("#steps"); const idx = STEPS.findIndex(s => s[0] === e.name); const li = ol.children[idx];
    if (li) { li.className = liveState[e.name]; li.querySelector("small").textContent = e.status === "skip" ? "reused checkpoint" : e.status === "start" ? `running${e.info?.attempt > 1 ? `, attempt ${e.info.attempt}` : ""}` : e.status === "unavailable" ? `unavailable: ${e.info}` : e.status === "fail" ? `failed: ${String(e.info).slice(0, 60)}` : e.status; }
    if (e.name === "report" && e.status === "done") openRun(id);
  });
  es.addEventListener("log", (ev) => { const e = JSON.parse(ev.data); $("#run-status").textContent = e.message.slice(0, 80); });
  es.addEventListener("done", () => { es.close(); es = null; openRun(id); });
  es.addEventListener("error", (ev) => { try { const e = JSON.parse(ev.data); $("#run-status").textContent = e.message.slice(0, 120); $("#run-status").className = "pill bad"; } catch {} es?.close(); es = null; setTimeout(() => openRun(id), 400); });
  // safety net if the stream drops
  pollTimer = setTimeout(async function poll() { const d = await api(`/runs/${id}`).catch(() => null); if (d && !d.running) openRun(id); else pollTimer = setTimeout(poll, 3000); }, 5000);
}

$("#request-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { product: f.get("product"), target_country: f.get("target_country"), min_headcount: Number(f.get("min_headcount")), max_headcount: Number(f.get("max_headcount")) };
  try { const { run_id } = await api("/runs", { method: "POST", body: JSON.stringify(body) }); await openRun(run_id); }
  catch (err) { alert(err.message); }
};
$("#resume-btn").onclick = async () => { await api(`/runs/${current}/resume`, { method: "POST" }); openRun(current); };
$("#rerun-btn").onclick = async () => { const d = await api(`/runs/${current}`); const { run_id } = await api("/runs", { method: "POST", body: JSON.stringify(d.run.request) }); openRun(run_id); };

health(); loadRuns(); setInterval(health, 15000);
const hash = location.hash.slice(1); if (hash) openRun(hash);

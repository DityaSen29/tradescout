/* A minimal client over the API in docs/api.md. It is meant to be replaced. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? "") ? u : null);
const LABEL = { import_record: "Import record", product_match: "Product match, no import proof", category_match: "Category match only", cannot_verify: "Cannot verify" };
let current = null, es = null;

async function api(path, body, method) {
  const r = await fetch(`/api${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status} on ${path}`);
  return d;
}
const traceLine = (agent, message) => `<div class="row"><b>${esc(agent)}</b> ${esc(message)}</div>`;

function leadRow(l, waiting) {
  const b = l.behaviour;
  const facts = b ? [`${b.records} records`, `${b.first_month} to ${b.last_month}`, b.total_value_usd && `$${b.total_value_usd.toLocaleString()}`, b.net_weight_kg && `${b.net_weight_kg.toLocaleString()} kg`, b.median_usd_per_kg && `median $${b.median_usd_per_kg}/kg`].filter(Boolean).join(" · ") : "";
  const proof = l.claims.map((c) => { const u = safeUrl(c.source_url); return `<li>${esc(c.text)}<br><q>${esc(c.quote)}</q> ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">source</a>` : `<span class="muted">${esc(c.record_id)}</span>`}</li>`; }).join("");
  return `<div class="row"><label>${waiting ? `<input type="checkbox" value="${esc(l.lead_id)}"> ` : ""}<strong>${esc(l.company.name)}</strong> ${esc(LABEL[l.match])}${l.related_party ? " · related party, ranked last" : ""} · fit ${esc(l.fit_score)}</label>
    <div class="muted">${esc(facts || l.match_reason)}</div>
    ${l.contact ? `<div>${esc(l.contact.name)}, ${esc(l.contact.title)} · ${esc(l.contact.email ?? "no work email")} (${esc(l.contact.email_status)})</div>` : ""}
    ${l.needs_person.length ? `<div class="muted">Needs a person: ${esc(l.needs_person.join("; "))}</div>` : ""}
    ${proof ? `<details><summary>${l.claims.length} evidence</summary><ul>${proof}</ul></details>` : ""}</div>`;
}

function render(d) {
  $("#status").textContent = d.run.status.replace(/_/g, " ");
  $("#cost").textContent = `${d.totals.credits_used.toFixed(1)} credits, about ₹${d.totals.estimated_inr}`;
  $("#trace").innerHTML = d.trace.map((t) => traceLine(t.agent, t.message)).join("") + d.steps.filter((s) => s.error).map((s) => traceLine(s.name, String(s.error).split("\n")[0])).join("");
  const waiting = d.run.status === "awaiting_person";
  const leads = d.report?.leads ?? d.shortlist;
  $("#shortlist").innerHTML = leads.map((l) => leadRow(l, waiting)).join("") || '<p class="muted">Nothing yet.</p>';
  $("#select").hidden = !waiting;
  $("#resume").hidden = d.running || !["failed", "running"].includes(d.run.status);
  $("#drafts").innerHTML = d.actions.filter((a) => a.kind === "email_draft").map((a) => `<div class="row" data-id="${esc(a.id)}"><strong>${esc(a.payload.subject)}</strong>
    <div class="muted">${esc(a.payload.company)} · ${esc(a.status)}</div><div class="body">${esc(a.payload.body)}</div>
    ${a.status === "proposed" ? '<button data-v="approve">Approve</button> <button class="quiet" data-v="reject">Reject</button>' : ""}
    ${a.status === "approved" ? '<button data-v="execute">Write to test outbox</button>' : ""}
    ${a.status === "unknown" ? "Outcome unknown: check it, then reconcile. It will not retry." : ""}</div>`).join("") || '<p class="muted">No drafts yet.</p>';
}

async function open(id) {
  current = id;
  es?.close(); es = null;
  const d = await api(`/runs/${id}`);
  render(d);
  const l = await api(`/runs/${id}/ledger`);
  $("#calls").innerHTML = l.calls.map((c) => `<div class="row">${esc(c.step)} · ${esc(c.endpoint)} · ${esc(c.status)} · ${c.credits ? `${esc(c.credits)} cr` : c.model_cost_usd ? `$${c.model_cost_usd.toFixed(4)}` : "free"}</div>`).join("");
  if (d.running) follow(id);
}

function follow(id) {
  $("#trace").innerHTML = "";
  es = new EventSource(`/api/runs/${id}/events`);
  const add = (a, m) => { $("#trace").insertAdjacentHTML("beforeend", traceLine(a, m)); $("#trace").scrollTop = 1e7; };
  es.addEventListener("agent", (ev) => { const e = JSON.parse(ev.data); add(e.agent, e.message); });
  es.addEventListener("step", (ev) => { const e = JSON.parse(ev.data); $("#status").textContent = `${e.name}: ${e.status}`; });
  const end = () => { es?.close(); es = null; setTimeout(() => current === id && open(id), 300); };
  es.addEventListener("done", end);
  es.addEventListener("error", end);
}

async function loadRuns() {
  $("#runs").innerHTML = (await api("/runs")).map((r) => `<div class="row"><button class="quiet" data-id="${esc(r.id)}">${esc(r.request.product)}, ${esc(r.request.target_country)}</button></div>`).join("");
}
const guarded = (fn) => async (e) => { try { await fn(e); } catch (err) { alert(err.message); } };

$("#brief").onsubmit = (e) => { e.preventDefault(); guarded(async () => {
  const f = Object.fromEntries(new FormData(e.target));
  const body = { product: f.product, target_country: f.target_country };
  if (f.hs_code) body.hs_code = f.hs_code.trim();
  if (f.client_name) body.client_name = f.client_name.trim();
  if (f.notes) body.notes = f.notes.trim();
  if (f.do_not_contact) body.do_not_contact = f.do_not_contact.split("\n").map((s) => s.trim()).filter(Boolean);
  const { run_id } = await api("/runs", body);
  await open(run_id); await loadRuns();
})(); };
$("#runs").onclick = guarded(async (e) => { if (e.target.dataset.id) await open(e.target.dataset.id); });
$("#select").onclick = guarded(async () => {
  await api(`/runs/${current}/select`, { lead_ids: [...document.querySelectorAll("#shortlist input:checked")].map((x) => x.value) });
  await open(current);
});
$("#resume").onclick = guarded(async () => { await api(`/runs/${current}/resume`, {}); await open(current); });
$("#drafts").onclick = guarded(async (e) => {
  const v = e.target.dataset.v; if (!v) return;
  const r = await api(`/actions/${e.target.closest("[data-id]").dataset.id}/${v}`, {});
  if (v === "execute" && r.ran === false) alert(r.reason || "Not written: this buyer already has an executed or unresolved email.");
  await open(current);
});
loadRuns().catch((err) => { $("#status").textContent = err.message; });

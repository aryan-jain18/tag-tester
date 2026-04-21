// DevTools panel main script.

const tabId = chrome.devtools.inspectedWindow.tabId;

const state = {
  requests: [],
  origin: "",
  host: "",
  consentDenied: false,
  cookies: [],
  dom: null,
  buffer: { dataLayer: [], console: [], cwv: null },
  storage: null,
  resourceTiming: [],
  auditResults: []
};

// Tabs
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === btn.dataset.tab));
  });
});

document.getElementById("run").addEventListener("click", runFull);
document.getElementById("refresh").addEventListener("click", refreshAll);
document.getElementById("clear").addEventListener("click", () => sendBg({ type: "clear-requests", tabId }).then(() => refreshAll()));
document.getElementById("consentDenied").addEventListener("change", (e) => {
  state.consentDenied = e.target.checked;
  sendBg({ type: "set-consent-denied", tabId, denied: state.consentDenied });
});
document.getElementById("export").addEventListener("click", exportJson);

function sendBg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }
function sendTab(msg) {
  return new Promise(r => chrome.tabs.sendMessage(tabId, msg, (resp) => {
    if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
    else r(resp);
  }));
}

async function refreshAll() {
  const reqResp = await sendBg({ type: "get-requests", tabId });
  if (reqResp?.ok) { state.requests = reqResp.requests || []; state.origin = reqResp.origin || ""; }
  const urlResp = await inspectedUrl();
  try { state.host = new URL(urlResp).hostname; state.origin = state.origin || new URL(urlResp).origin; } catch {}
  const cookiesResp = await sendBg({ type: "get-cookies", url: urlResp });
  state.cookies = cookiesResp?.cookies || [];
  const domResp = await sendTab({ type: "scan-dom" });
  state.dom = domResp?.data || null;
  const bufResp = await sendTab({ type: "get-buffer" });
  if (bufResp?.ok && bufResp.data) state.buffer = bufResp.data;
  const stResp = await sendTab({ type: "snapshot-storage" });
  state.storage = stResp?.data || null;
  const rtResp = await sendTab({ type: "resource-timing" });
  state.resourceTiming = rtResp?.data || [];
  render();
}

function inspectedUrl() {
  return new Promise(r => chrome.devtools.inspectedWindow.eval("location.href", (res) => r(res)));
}

async function runFull() {
  await refreshAll();
  const ctx = {
    requests: state.requests,
    cookies: state.cookies,
    dom: state.dom,
    console: state.buffer.console || [],
    cwv: state.buffer.cwv,
    storage: state.storage,
    resourceTiming: state.resourceTiming,
    origin: state.origin,
    host: state.host,
    consentDenied: state.consentDenied
  };
  const results = AUDIT_DEFS.map(def => {
    try { return { ...def, result: def.run(ctx) }; }
    catch (e) { return { ...def, result: { status: "info", summary: "Error: " + e.message, table: null } }; }
  });
  state.auditResults = results;
  renderSummary();
}

function render() {
  renderSummary();
  renderTags();
  renderDataLayer();
  renderRequests();
  renderCookies();
  renderStorage();
  renderConsole();
}

function statusBadge(s) {
  const map = { pass: "b-pass", warn: "b-warn", fail: "b-fail", info: "b-info", skip: "b-skip" };
  return `<span class="badge ${map[s]||"b-info"}">${s.toUpperCase()}</span>`;
}

function renderSummary() {
  const host = document.getElementById("summary");
  if (!state.auditResults.length) {
    host.innerHTML = `<div class="card"><div class="body">Click <b>Run Audit</b> to execute all 21 audits against the current page. Tip: toggle <i>Simulate consent denied</i> and reload to validate consent-gated tags (AUD-004, AUD-005).</div></div>`;
    return;
  }
  const counts = { pass:0, warn:0, fail:0, info:0, skip:0 };
  for (const r of state.auditResults) counts[r.result.status] = (counts[r.result.status]||0)+1;
  const header = `<div class="row-flex">
    <div class="stat"><div class="k">Pass</div><div class="v">${counts.pass}</div></div>
    <div class="stat"><div class="k">Warn</div><div class="v">${counts.warn}</div></div>
    <div class="stat"><div class="k">Fail</div><div class="v">${counts.fail}</div></div>
    <div class="stat"><div class="k">Info</div><div class="v">${counts.info}</div></div>
    <div class="stat"><div class="k">Skip</div><div class="v">${counts.skip}</div></div>
  </div>`;
  const cards = state.auditResults.map(a => {
    const rows = a.result.table?.rows || [];
    const cols = a.result.table?.columns || [];
    const body = cols.length && rows.length
      ? `<table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>${
          rows.slice(0, 500).map(r => `<tr>${cols.map(c=>`<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      : "";
    return `<div class="card">
      <header>
        <div><b>${a.id}</b> — ${a.name} <span class="pill">${a.category}</span> ${statusBadge(a.result.status)}</div>
      </header>
      <div class="body">
        <div>${escapeHtml(a.result.summary || "")}</div>
        ${body ? `<details style="margin-top:6px;"><summary>Details (${rows.length})</summary>${body}</details>` : ""}
      </div>
    </div>`;
  }).join("");
  host.innerHTML = header + cards;
}

function renderTags() {
  const host = document.getElementById("tags");
  const hits = state.requests.filter(r => r.provider);
  const byKey = new Map();
  for (const h of hits) {
    const arr = byKey.get(h.provider.key) || [];
    arr.push(h); byKey.set(h.provider.key, arr);
  }
  if (!byKey.size) { host.innerHTML = `<div class="card"><div class="body">No known tag/pixel providers detected yet. Interact with the page or reload.</div></div>`; return; }
  host.innerHTML = Array.from(byKey.entries()).map(([k, arr]) => {
    const p = arr[0].provider;
    const rows = arr.map(r => {
      const f = r.provider.fields || {};
      const kv = Object.entries(f).map(([k,v])=>`<div><b>${escapeHtml(k)}:</b></div><div>${escapeHtml(String(v))}</div>`).join("");
      return `<tr><td style="width:40%"><code>${escapeHtml(truncate(r.url,120))}</code></td><td>${r.method}</td><td>${r.status ?? ""}</td><td><div class="kv">${kv}</div></td></tr>`;
    }).join("");
    return `<div class="card"><header><div><b>${p.name}</b> <span class="pill prov-${(p.category||"").replace('/','')}">${p.category}</span></div><div>${arr.length} hits</div></header><div class="body"><table><thead><tr><th>URL</th><th>Method</th><th>Status</th><th>Fields</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join("");
}

function renderDataLayer() {
  const host = document.getElementById("datalayer");
  const list = state.buffer.dataLayer || [];
  if (!list.length) { host.innerHTML = `<div class="card"><div class="body">No dataLayer pushes captured. If the site uses GTM/Adobe, reload the page with the panel open.</div></div>`; return; }
  host.innerHTML = `<div class="card"><header><div><b>dataLayer</b></div><div>${list.length} pushes</div></header><div class="body">${
    list.map((e, i) => `<details ${i===list.length-1?"open":""}><summary>#${i+1} ${e.historical?"[historical]":""} ${escapeHtml((e.value && e.value.event) || inferLabel(e.value))}</summary><pre>${escapeHtml(JSON.stringify(e.value, null, 2))}</pre></details>`).join("")
  }</div></div>`;
}

function inferLabel(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return Object.keys(v).slice(0,3).join(", ");
  return String(v).slice(0,60);
}

function renderRequests() {
  const host = document.getElementById("requests");
  const rows = state.requests.slice(-500).reverse();
  host.innerHTML = `<div class="card"><header><div><b>Network</b> (filter: <input class="search" id="netFilter" placeholder="substring..."></input>)</div><div>${state.requests.length} total</div></header><div class="body"><table id="netTable"><thead><tr><th>#</th><th>Method</th><th>Status</th><th>Type</th><th>Provider</th><th>URL</th></tr></thead><tbody>${
    rows.map((r,i)=>`<tr><td>${i+1}</td><td>${r.method}</td><td>${r.status ?? (r.error?"ERR":"")}</td><td>${r.type}</td><td>${r.provider?escapeHtml(r.provider.name):""}</td><td><code>${escapeHtml(truncate(r.url,180))}</code></td></tr>`).join("")
  }</tbody></table></div></div>`;
  const inp = document.getElementById("netFilter");
  inp?.addEventListener("input", () => {
    const q = inp.value.toLowerCase();
    document.querySelectorAll("#netTable tbody tr").forEach(tr => {
      tr.style.display = tr.innerText.toLowerCase().includes(q) ? "" : "none";
    });
  });
}

function renderCookies() {
  const host = document.getElementById("cookies");
  if (!state.cookies.length) { host.innerHTML = `<div class="card"><div class="body">No cookies or origin not detected.</div></div>`; return; }
  host.innerHTML = `<div class="card"><header><div><b>Cookies</b></div><div>${state.cookies.length}</div></header><div class="body"><table><thead><tr><th>Name</th><th>Domain</th><th>Path</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th><th>Expires</th><th>Value (preview)</th></tr></thead><tbody>${
    state.cookies.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.domain)}</td><td>${escapeHtml(c.path)}</td><td>${c.secure}</td><td>${c.httpOnly}</td><td>${c.sameSite||""}</td><td>${c.expirationDate?new Date(c.expirationDate*1000).toLocaleString():"session"}</td><td><code>${escapeHtml(String(c.value||"").slice(0,120))}</code></td></tr>`).join("")
  }</tbody></table></div></div>`;
}

function renderStorage() {
  const host = document.getElementById("storage");
  const s = state.storage || { local: {}, session: {}, idbDbs: [] };
  const section = (label, obj) => `<details open><summary><b>${label}</b> (${Object.keys(obj||{}).length})</summary><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${
    Object.entries(obj||{}).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td><code>${escapeHtml(String(v).slice(0,500))}</code></td></tr>`).join("")
  }</tbody></table></details>`;
  host.innerHTML = `<div class="card"><header><div><b>Storage</b></div></header><div class="body">${section("localStorage", s.local)}${section("sessionStorage", s.session)}<div><b>IndexedDB databases:</b> ${(s.idbDbs||[]).map(n=>`<span class="pill">${escapeHtml(n)}</span>`).join("") || "—"}</div></div></div>`;
}

function renderConsole() {
  const host = document.getElementById("console");
  const rows = state.buffer.console || [];
  host.innerHTML = `<div class="card"><header><div><b>Console</b></div><div>${rows.length} entries</div></header><div class="body"><table><thead><tr><th>Level</th><th>Message</th><th>Source</th></tr></thead><tbody>${
    rows.map(c => `<tr><td>${statusBadge(c.level==="error"?"fail":"warn")}</td><td><code>${escapeHtml(String(c.message).slice(0,600))}</code></td><td>${escapeHtml(c.source||"")}</td></tr>`).join("")
  }</tbody></table></div></div>`;
}

function exportJson() {
  const out = {
    url: state.origin, host: state.host, consentDenied: state.consentDenied,
    timestamp: new Date().toISOString(),
    requests: state.requests, cookies: state.cookies, dom: state.dom,
    buffer: state.buffer, storage: state.storage, resourceTiming: state.resourceTiming,
    auditResults: state.auditResults.map(a => ({ id: a.id, name: a.name, category: a.category, result: a.result }))
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `gtm-audit-${state.host || "site"}-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }
function truncate(s, n) { return (s||"").length > n ? s.slice(0,n)+"…" : (s||""); }

// Auto load on first open
refreshAll();

// Light refresh on navigation
chrome.devtools.network.onNavigated.addListener(() => setTimeout(refreshAll, 800));

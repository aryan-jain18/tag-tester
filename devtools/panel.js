// Tag Tester — DevTools panel logic.

const tabId = chrome.devtools.inspectedWindow.tabId;
let lastContext = null;
let lastResults = null;
let live = { requests: [], requestIndex: new Map(), pageState: {}, origin: "" };
let liveEnabled = true;
let renderTimer = null;
let requestCategoryFilter = null; // e.g. "analytics", "ads", "replay", "loader"

function connectLive() {
  const port = chrome.runtime.connect({ name: "tt-panel-" + tabId });
  port.onMessage.addListener((msg) => {
    if (msg.type === "snapshot") {
      live.requests = msg.requests || [];
      live.requestIndex = new Map(live.requests.map((r, i) => [r.id, i]));
      live.pageState = msg.pageState || {};
      live.origin = msg.origin || "";
    } else if (msg.type === "request") {
      live.requestIndex.set(msg.r.id, live.requests.length);
      live.requests.push(msg.r);
    } else if (msg.type === "requestUpdate") {
      const i = live.requestIndex.get(msg.id);
      if (i != null) Object.assign(live.requests[i], msg.patch);
    } else if (msg.type === "pageState") {
      live.pageState = msg.pageState || {};
      live.origin = msg.origin || live.origin;
    }
    if (liveEnabled) scheduleRender();
  });
  port.onDisconnect.addListener(() => { setTimeout(connectLive, 500); });
}

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; runAudit(); }, 300);
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById("tab-" + b.dataset.tab).classList.add("active");
  });
});

document.getElementById("live").addEventListener("click", () => {
  liveEnabled = !liveEnabled;
  document.getElementById("live").textContent = liveEnabled ? "⏸ Pause live" : "▶ Resume live";
  if (liveEnabled) scheduleRender();
});
document.getElementById("run").addEventListener("click", runAudit);
document.getElementById("reload").addEventListener("click", () => chrome.tabs.reload(tabId));
document.getElementById("region").addEventListener("change", () => { if (lastContext) runAudit(); });
document.getElementById("clearTracking").addEventListener("click", () => clearCookies("tracking", false));
document.getElementById("clearAll").addEventListener("click", () => clearCookies("all", true));
document.getElementById("export").addEventListener("click", exportJson);

async function runAudit() {
  const ctx = await getContext();
  const region = document.getElementById("region").value;
  const annotated = window.TTParsers.annotate(ctx.requests);
  const input = { ...ctx, annotated, region };
  const results = {
    consent: window.TTRules.consent.run(input),
    analytics: window.TTRules.analytics.run(input),
    events: window.TTRules.events.run(input),
    ads: window.TTRules.ads.run(input),
    cookies: window.TTRules.cookies.run(input)
  };
  const piiFindings = detectPii(annotated, ctx.pageState?.dataLayer || []);
  lastContext = input;
  lastResults = results;
  renderSummary(results, annotated, piiFindings);
  renderDestinationsTab(annotated);
  renderRequests(annotated);
  renderUserData(piiFindings);
  renderDataLayer(ctx.pageState?.dataLayer || []);
  renderCookies(ctx.cookies || []);
  renderPageState(ctx.pageState || {});
  const live = liveEnabled ? " · LIVE" : "";
  setStatus(`${ctx.requests.length} requests • ${Object.values(results).flat().length} rules${live}`);
  document.getElementById("auditedCount").textContent = `Audited ${ctx.requests.length} requests • ${Object.values(results).flat().length} rules`;
}

function getContext() {
  // Use the live buffer; only fetch cookies via background (requires chrome.cookies API there).
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "TT_GET_COOKIES", tabId }, (res) => {
      resolve({
        requests: live.requests.slice(),
        pageState: live.pageState,
        origin: live.origin,
        host: (() => { try { return new URL(live.origin).hostname; } catch { return ""; } })(),
        cookies: (res && res.cookies) || []
      });
    });
  });
}

async function clearCookies(scope, alsoStorage) {
  setStatus("Clearing cookies…");
  chrome.runtime.sendMessage({ type: "TT_CLEAR_COOKIES", tabId, scope, alsoStorage }, (res) => {
    setStatus(`Cleared ${res?.removed || 0} cookies${alsoStorage ? " + storage" : ""}`);
    chrome.runtime.sendMessage({ type: "TT_CLEAR_TAB", tabId });
    if (alsoStorage) setTimeout(() => chrome.tabs.reload(tabId), 250);
  });
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ context: lastContext, results: lastResults }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `tag-tester-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setStatus(s) { document.getElementById("status").textContent = s; }

function renderDestinations(annotated) {
  // Group by provider.key; collect IDs sent, request counts, and consent signal coverage.
  const groups = new Map();
  for (const r of annotated) {
    if (!r.provider) continue;
    const k = r.provider.key;
    if (!groups.has(k)) groups.set(k, { provider: r.provider, ids: new Map(), count: 0, withConsent: 0 });
    const g = groups.get(k);
    g.count++;
    const id = pickId(r);
    if (id) g.ids.set(id, (g.ids.get(id) || 0) + 1);
    // Consent signal presence — only meaningful for platforms that carry gcs/gcd
    if (/gcs=|gcd=/.test(r.url)) g.withConsent++;
  }
  if (!groups.size) return "";

  const byCat = { analytics: [], ads: [], replay: [], loader: [] };
  for (const g of groups.values()) (byCat[g.provider.category] || (byCat.other = byCat.other || [])).push(g);

  const catTitle = { analytics: "Analytics", ads: "Ads", replay: "Session replay", loader: "Tag loaders" };
  const section = (key) => {
    const list = byCat[key] || [];
    if (!list.length) return "";
    const rows = list.map((g) => {
      const idList = Array.from(g.ids.entries()).map(([id, n]) => `${escapeHtml(id)}${n > 1 ? ` <span class="dim">×${n}</span>` : ""}`).join(", ") || '<span class="dim">(no id captured)</span>';
      const consentBadge = /ga4|google_ads_conv|floodlight|meta|tiktok|linkedin|bing/.test(g.provider.key)
        ? (g.withConsent === g.count ? '<span class="pill pass">gcs ✓</span>' : g.withConsent ? `<span class="pill warn">gcs ${g.withConsent}/${g.count}</span>` : '<span class="pill fail">no gcs</span>')
        : "";
      return `<tr class="dest-row" data-dest-cat="${key}" title="Filter Requests by ${catTitle[key]}">
        <td><span class="provider-tag ${g.provider.category}">${escapeHtml(g.provider.name)}</span></td>
        <td>${idList}</td>
        <td>${g.count} hit${g.count > 1 ? "s" : ""}</td>
        <td>${consentBadge}</td>
      </tr>`;
    }).join("");
    return `<h4 class="dest-cat dest-cat-click" data-dest-cat="${key}" title="Filter Requests by ${catTitle[key]}">${catTitle[key]}</h4>
      <table class="dest-table"><tbody>${rows}</tbody></table>`;
  };

  return `<div class="destinations">
    <div class="dest-header">Destinations — where this page is sending data</div>
    ${section("analytics")}${section("ads")}${section("replay")}${section("loader")}
  </div>`;
}

function wireDestinationFilters(scopeEl) {
  if (!scopeEl) return;
  const go = (cat) => {
    if (!cat) return;
    requestCategoryFilter = cat;
    const btn = document.querySelector('.tabs button[data-tab="requests"]');
    if (btn) btn.click();
    if (lastContext) renderRequests(lastContext.annotated || []);
  };
  scopeEl.querySelectorAll("[data-dest-cat]").forEach((node) => {
    node.addEventListener("click", () => go(node.dataset.destCat));
  });
}

function pickId(r) {
  const f = r.fields || {};
  return f.tid || f.awId || f.id || f.ti || f.pid || f.src || "";
}

// Plain-English messages per rule — { good, bad } are shown to users;
// `why` explains the business impact. Falls back to rule title when missing.
const FRIENDLY = {
  "CONSENT-001": {
    good: "A consent management platform (CMP) is active on the page.",
    bad: "No consent management platform (CMP) was detected — visitors in regulated regions may not be asked for consent.",
    why: "Required in the EU/UK and for Google Consent Mode to work."
  },
  "CONSENT-002": {
    good: "Every GA4 hit includes a consent signal (gcs).",
    bad: "Some GA4 hits are missing the consent signal (gcs) — Google may reject or model them.",
    why: "Without gcs, GA4 data quality and ads measurement suffer."
  },
  "CONSENT-003": {
    good: "Consent Mode v2 signals are being sent to Google.",
    bad: "Consent Mode v2 signals (ad_user_data / ad_personalization) are missing.",
    why: "Consent Mode v2 is required by Google for EEA ads personalization."
  },
  "CONSENT-004": {
    good: "Ad pixels in the EU are carrying a consent signal.",
    bad: "Ad pixels are firing in the EU without a consent signal — this is a compliance risk.",
    why: "EU regulators require prior consent before ad tracking."
  },
  "CONSENT-005": {
    good: "Session replay is properly gated by consent.",
    bad: "Session replay may be running before the user has given consent.",
    why: "Replay captures personal data and must be consented to in the EU."
  },
  "CONSENT-006": {
    good: "gtag('consent', …) calls were observed in the dataLayer.",
    bad: "No gtag('consent', …) calls observed yet — consent state may not be communicated to tags.",
    why: "Consent Mode needs these calls to tell Google the user's choice."
  },
  "ANALYTICS-001": {
    good: "Google Analytics / gtag loader is installed on the page.",
    bad: "No Google Analytics / gtag loader detected — analytics may not be collecting data.",
    why: "Needed for any GA4 measurement to happen at all."
  },
  "ANALYTICS-002": {
    good: "Only one GA4 measurement ID is active on this page.",
    bad: "Multiple GA4 measurement IDs are firing — data may be split across properties.",
    why: "Multiple IDs often indicates stale or duplicated tagging."
  },
  "ANALYTICS-003": {
    good: "No duplicate GA4 loader requests for the same container.",
    bad: "The GA4/GTM loader is being requested more than once — each hit may be double-counted.",
    why: "Duplicate loaders inflate sessions and events."
  },
  "ANALYTICS-004": {
    good: "GA4 debug_mode is disabled in production.",
    bad: "GA4 debug_mode appears enabled in production — these hits are excluded from reports.",
    why: "Debug hits don't count in your real GA4 data."
  },
  "ANALYTICS-005": {
    good: "Every GA4 hit carries a measurement ID.",
    bad: "Some GA4 hits are missing a measurement ID — those events won't be attributed.",
    why: "Without tid, Google can't route the hit to a property."
  },
  "ANALYTICS-006": {
    good: "Google Tag Manager / Google Tag container detected.",
    bad: "No GTM container detected on the page.",
    why: "GTM is optional but common for managing tags."
  },
  "EVENTS-001": {
    good: "GA4 purchase events include value, currency, and items.",
    bad: "Some GA4 purchase events are missing value, currency, or items — revenue reports will be incomplete.",
    why: "Ecommerce reporting and ad bidding rely on these fields."
  },
  "EVENTS-002": {
    good: "No events have a value without a currency.",
    bad: "Some events have a value but no currency — GA4 will ignore the revenue.",
    why: "Currency is mandatory whenever value is set."
  },
  "EVENTS-003": {
    good: "Event value parameters are numeric.",
    bad: "One or more event values are not numeric — they'll be dropped in GA4.",
    why: "GA4 requires value to be a number."
  },
  "EVENTS-004": {
    good: "page_view fires exactly once per navigation.",
    bad: "page_view is firing multiple times per navigation — sessions and pages may be inflated.",
    why: "Duplicate page_views distort engagement metrics."
  },
  "EVENTS-005": {
    good: "Only one revenue event type is active.",
    bad: "Multiple revenue event types are active — revenue may be double-counted.",
    why: "Pick one (e.g. purchase) to avoid double counting."
  },
  "EVENTS-006": {
    good: "Ecommerce dataLayer uses the GA4 items[] schema.",
    bad: "Ecommerce dataLayer still uses legacy UA products[] — GA4 won't read it.",
    why: "GA4 expects items[], not Universal Analytics products[]."
  },
  "ADS-001": {
    good: "Ad platforms are detected on the page.",
    bad: "No ad platforms detected on the page.",
    why: "Expected if you run paid media on this site."
  },
  "ADS-002": {
    good: "Conversion Linker is present to preserve GCLID for attribution.",
    bad: "Conversion Linker is missing — Google Ads attribution may break on cross-domain journeys.",
    why: "Preserves the GCLID click ID needed for conversion matching."
  },
  "ADS-003": {
    good: "The Google tag loads before Ads conversions fire.",
    bad: "Google Ads conversions may fire before the gtag loader is ready — conversions can be lost.",
    why: "gtag must initialize first for conversions to record."
  },
  "ADS-004": {
    good: "Google Ads conversions include a value.",
    bad: "Google Ads conversions are missing a value — bidding and ROAS reporting will be off.",
    why: "Smart Bidding relies on conversion value."
  },
  "ADS-005": {
    good: "Floodlight sales tags include a unique ord= parameter.",
    bad: "Floodlight sales tags are missing or reusing ord= — duplicate conversions possible.",
    why: "ord= prevents duplicate Floodlight conversions."
  },
  "ADS-006": {
    good: "Platform click IDs (gclid / fbclid / etc.) were found in the landing URL.",
    bad: "No platform click IDs in the landing URL.",
    why: "Expected if you arrived from a paid ad click."
  },
  "ADS-007": {
    good: "UTM values are persisted to localStorage for iOS ITP resilience.",
    bad: "UTM values are not persisted — iOS users may lose attribution across sessions.",
    why: "Safari ITP shortens cookies; storing UTMs helps attribution."
  },
  "ADS-008": {
    good: "Google Ads conversion fires on a small number of distinct pages.",
    bad: "Google Ads conversion is firing on many pages — it may be mis-tagged.",
    why: "A conversion tag on every page inflates conversions."
  },
  "COOKIES-001": {
    good: "Google tracking cookies use a reduced expiry in the EU.",
    bad: "Google tracking cookies have long expiry in the EU — check ePrivacy compliance.",
    why: "EU guidance recommends shorter cookie lifetimes."
  },
  "COOKIES-002": {
    good: "Tracking cookies use persistent expiry (not session-only).",
    bad: "Tracking cookies are session-only — returning visitors won't be recognized.",
    why: "Session-only cookies break re-identification."
  },
  "COOKIES-003": {
    good: "Cookie inventory captured.",
    bad: "Cookie inventory unavailable.",
    why: "Informational."
  }
};

function friendlyFor(r) {
  const f = FRIENDLY[r.id];
  if (!f) return { text: r.title, why: "" };
  if (r.status === "pass") return { text: f.good, why: "" };
  if (r.status === "fail" || r.status === "warn") return { text: f.bad, why: f.why || "" };
  return { text: f.good, why: "" };
}

// ───── PII / user-data detection ─────

// Unambiguous PII names — safe to flag anywhere, any vendor.
const PII_PARAM_NAMES = {
  email: ["email", "e_mail", "user_email", "useremail", "mail", "mailto", "email_address"],
  phone: ["phone", "tel", "telephone", "mobile", "phone_number", "cellphone"],
  first_name: ["first_name", "firstname", "given_name"],
  last_name: ["last_name", "lastname", "family_name", "surname"],
  full_name: ["full_name", "fullname", "user_name"],
  user_id: ["user_id", "userid", "customer_id", "customerid", "external_id", "externalid"],
  dob: ["dob", "birthday", "birthdate", "date_of_birth"],
  gender: ["sex"],
  zip: ["zipcode", "postal_code", "postcode"],
  state: ["state_province"],
  address: ["street_address", "address_line_1", "address_line_2"]
};

// Ambiguous short aliases — ONLY treated as PII when the request belongs to a
// vendor known to use them that way (e.g. Meta Pixel's em/ph/fn/ln). Matching
// these on arbitrary page-level requests causes false positives like ln=en-us
// (a locale) being flagged as "last_name".
const AMBIGUOUS_PII_ALIASES = {
  em: "email", ph: "phone", fn: "first_name", ln: "last_name",
  ge: "gender", db: "dob", ct: "city", zp: "zip", pn: "phone",
  uid: "user_id"
};

// Vendor-specific fields that MUST be SHA-256 hashed.
const VENDOR_HASH_EXPECTATIONS = {
  meta: { em: 1, ph: 1, fn: 1, ln: 1, ge: 1, db: 1, ct: 1, zp: 1, st: 1, country: 1, external_id: 1 },
  google_ads_conv: {
    em: 1, sha256_email_address: 1, sha256_phone_number: 1,
    sha256_first_name: 1, sha256_last_name: 1, sha256_street: 1
  },
  tiktok: { email: 1, phone_number: 1, external_id: 1, "context.user.email": 1, "context.user.phone_number": 1 }
};

const SHA256_RE = /^[a-f0-9]{64}$/i;
const SHA1_RE = /^[a-f0-9]{40}$/i;
const MD5_RE = /^[a-f0-9]{32}$/i;
const EMAIL_RE = /[\w.+%-]+@[\w-]+\.[\w.-]{2,}/;

function piiParamType(key, { vendorKey = "", expectations = {} } = {}) {
  const k = String(key).toLowerCase();
  for (const [type, names] of Object.entries(PII_PARAM_NAMES)) {
    if (names.some((n) => n.toLowerCase() === k)) return type;
  }
  // Short aliases only count when the vendor is known to use them this way.
  if (AMBIGUOUS_PII_ALIASES[k] && (vendorKey && expectations[k])) return AMBIGUOUS_PII_ALIASES[k];
  return null;
}

function requestDestination(r) {
  if (r.provider?.name) return r.provider.name;
  try { return new URL(r.url).hostname; } catch { return "(unknown)"; }
}

function classifyValue(v) {
  if (v == null || v === "") return "empty";
  const s = String(v);
  if (SHA256_RE.test(s)) return "sha256";
  if (SHA1_RE.test(s)) return "sha1";
  if (MD5_RE.test(s)) return "md5";
  if (EMAIL_RE.test(s)) return "raw_email";
  return "other";
}

function safeDecode(v) { try { return decodeURIComponent(String(v)); } catch { return String(v); } }

function flattenInto(out, obj, prefix) {
  if (obj == null) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => flattenInto(out, v, prefix ? `${prefix}[${i}]` : `[${i}]`)); return; }
  if (typeof obj === "object") { for (const [k, v] of Object.entries(obj)) flattenInto(out, v, prefix ? `${prefix}.${k}` : k); return; }
  out[prefix] = String(obj);
}

function collectParams(r) {
  const params = {};
  try { new URL(r.url).searchParams.forEach((v, k) => { params[k] = v; }); } catch {}
  if (r.postBody) {
    try { new URLSearchParams(r.postBody).forEach((v, k) => { params[k] = v; }); } catch {}
    if (/^\s*[{\[]/.test(r.postBody)) {
      try { const j = JSON.parse(r.postBody); flattenInto(params, j, ""); } catch {}
    }
  }
  return params;
}

function truncateSample(s, n = 60) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function detectPii(annotated, dataLayerPushes) {
  const findings = [];
  const push = (f) => findings.push(f);

  for (const r of (annotated || [])) {
    const vendorKey = r.provider?.key || "";
    const vendorName = requestDestination(r);
    const destHost = (() => { try { return new URL(r.url).hostname; } catch { return ""; } })();
    const expectations = VENDOR_HASH_EXPECTATIONS[vendorKey] || {};
    const params = collectParams(r);

    for (const [key, rawVal] of Object.entries(params)) {
      if (rawVal == null || rawVal === "") continue;
      const val = safeDecode(rawVal);
      const kind = classifyValue(val);
      const expected = expectations[key] || expectations[key.toLowerCase()];
      const piiType = piiParamType(key, { vendorKey, expectations });

      const base = { vendor: vendorName, destHost, source: "request", field: key };

      if (expected) {
        if (kind === "sha256") push({ ...base, severity: "ok", piiType: piiType || "user_data", valueKind: "sha256", sample: truncateSample(val, 20), note: "Hashed as expected" });
        else if (kind === "md5" || kind === "sha1") push({ ...base, severity: "warn", piiType: piiType || "user_data", valueKind: kind, sample: truncateSample(val, 20), note: `Weak hash (${kind}). Vendor requires SHA-256.` });
        else if (kind === "raw_email" || piiType) push({ ...base, severity: "fail", piiType: piiType || "user_data", valueKind: kind, sample: truncateSample(val), note: "Vendor requires SHA-256 but received raw value." });
        continue;
      }

      if (piiType) {
        if (kind === "sha256") push({ ...base, severity: "ok", piiType, valueKind: "sha256", sample: truncateSample(val, 20), note: "Hashed" });
        else if (kind === "raw_email") push({ ...base, severity: "fail", piiType: "email", valueKind: "raw_email", sample: truncateSample(val), note: "Raw email in PII-named parameter" });
        else if (piiType === "user_id") push({ ...base, severity: "info", piiType, valueKind: "other", sample: truncateSample(val, 32), note: "Pseudonymous user ID" });
        else if (piiType === "email") { /* named email but value not email-shape — skip */ }
        else push({ ...base, severity: "fail", piiType, valueKind: "other", sample: truncateSample(val), note: `Raw ${piiType} sent unhashed` });
        continue;
      }

      if (kind === "raw_email") {
        push({ ...base, severity: "fail", piiType: "email", valueKind: "raw_email", sample: truncateSample(val), note: "Raw email found in URL/body" });
      }
    }
  }

  for (const p of (dataLayerPushes || [])) {
    const flat = {};
    flattenInto(flat, p.e, "");
    for (const [key, rawVal] of Object.entries(flat)) {
      if (rawVal == null || rawVal === "") continue;
      const val = safeDecode(rawVal);
      const kind = classifyValue(val);
      const piiType = piiParamType(key.split(".").pop());

      if (piiType === "user_id" && kind !== "raw_email") {
        push({ severity: "info", vendor: "dataLayer", source: "datalayer", field: key, piiType, valueKind: "other", sample: truncateSample(val, 32), note: "Pseudonymous user ID in dataLayer" });
      } else if (piiType && kind === "raw_email") {
        push({ severity: "fail", vendor: "dataLayer", source: "datalayer", field: key, piiType: "email", valueKind: "raw_email", sample: truncateSample(val), note: "Raw email pushed to dataLayer" });
      } else if (piiType && kind === "other" && piiType !== "email" && piiType !== "user_id") {
        push({ severity: "warn", vendor: "dataLayer", source: "datalayer", field: key, piiType, valueKind: "other", sample: truncateSample(val), note: `Raw ${piiType} pushed to dataLayer` });
      } else if (!piiType && kind === "raw_email") {
        push({ severity: "fail", vendor: "dataLayer", source: "datalayer", field: key, piiType: "email", valueKind: "raw_email", sample: truncateSample(val), note: "Raw email found in dataLayer push" });
      } else if (piiType && kind === "sha256") {
        push({ severity: "ok", vendor: "dataLayer", source: "datalayer", field: key, piiType, valueKind: "sha256", sample: truncateSample(val, 20), note: "Hashed user data in dataLayer" });
      }
    }
  }

  // Dedupe by vendor+destHost+field+valueKind+sample — identical requests collapse to one row with a count.
  const seen = new Map();
  for (const f of findings) {
    const k = `${f.source}|${f.vendor}|${f.destHost || ""}|${f.field}|${f.valueKind}|${f.sample}`;
    if (seen.has(k)) seen.get(k).count++;
    else { f.count = 1; seen.set(k, f); }
  }
  return Array.from(seen.values());
}

function renderUserData(findings) {
  const el = document.getElementById("tab-userdata");
  if (!findings || !findings.length) {
    el.innerHTML = `<div class="ud-empty">
      <h3>No user data detected yet</h3>
      <p>As tags fire, this tab will show what user data (emails, phones, names, IDs) is being sent — and whether it's hashed (compliant) or raw (violation).</p>
    </div>`;
    return;
  }

  const groups = {
    fail: findings.filter((f) => f.severity === "fail"),
    warn: findings.filter((f) => f.severity === "warn"),
    ok: findings.filter((f) => f.severity === "ok"),
    info: findings.filter((f) => f.severity === "info")
  };

  const header = `<div class="ud-header">
    <div class="ud-health ${groups.fail.length ? "bad" : groups.warn.length ? "warn" : "good"}">
      ${groups.fail.length ? `${groups.fail.length} PII violation${groups.fail.length === 1 ? "" : "s"}`
        : groups.warn.length ? `${groups.warn.length} potential issue${groups.warn.length === 1 ? "" : "s"}`
        : "No raw PII detected"}
    </div>
    <div class="ud-chips">
      <span class="chip fail">${groups.fail.length} raw</span>
      <span class="chip warn">${groups.warn.length} weak</span>
      <span class="chip pass">${groups.ok.length} hashed</span>
      <span class="chip">${groups.info.length} IDs</span>
    </div>
  </div>`;

  const section = (title, items, severityClass, intro) => {
    if (!items.length) return "";
    return `<h3 class="ud-section ${severityClass}">${title} · ${items.length}</h3>
      ${intro ? `<p class="ud-intro">${intro}</p>` : ""}
      <table class="ud-table">
        <thead><tr><th>Destination</th><th>Field</th><th>Type</th><th>Value (preview)</th><th>Why</th></tr></thead>
        <tbody>
          ${items.map((f) => {
            const vendorIsHost = f.destHost && (f.vendor === f.destHost);
            const destCell = f.source === "datalayer"
              ? `<strong>dataLayer</strong>`
              : vendorIsHost
                ? `<span class="dim">unrecognized tag</span><br><code class="ud-host">${escapeHtml(f.destHost)}</code>`
                : `<strong>${escapeHtml(f.vendor)}</strong>${f.destHost ? `<br><code class="ud-host">${escapeHtml(f.destHost)}</code>` : ""}`;
            return `<tr class="ud-row sev-${f.severity}">
              <td>${destCell}${f.count > 1 ? ` <span class="dim">×${f.count}</span>` : ""}</td>
              <td><code>${escapeHtml(f.field)}</code></td>
              <td><span class="pii-type">${escapeHtml(f.piiType || "—")}</span></td>
              <td><code class="ud-sample">${escapeHtml(f.sample)}</code></td>
              <td>${escapeHtml(f.note)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  };

  el.innerHTML = header
    + section("Raw PII sent (compliance risk)", groups.fail, "fail", "These values are personal data sent in the clear or in fields a vendor requires to be SHA-256 hashed.")
    + section("Weak hashing", groups.warn, "warn", "Values appear to be hashed with MD5/SHA-1 instead of SHA-256, or contain raw PII in an unexpected field.")
    + section("Hashed user data (compliant)", groups.ok, "ok", "These are properly SHA-256 hashed before being sent — expected vendor behavior.")
    + section("Pseudonymous IDs", groups.info, "info", "Non-PII identifiers used to stitch sessions. Not a violation by themselves but still personal data under GDPR.");
}

function renderDestinationsTab(annotated) {
  const el = document.getElementById("tab-destinations");
  const html = renderDestinations(annotated || []);
  el.innerHTML = html || `<div class="ud-empty">
    <h3>No destinations captured yet</h3>
    <p>As tag, pixel, and analytics requests fire, this tab will group them by vendor and show the IDs, hit counts, and consent-signal coverage for each.</p>
  </div>`;
  wireDestinationFilters(el);
}

function renderSummary(results, annotated, piiFindings) {
  const el = document.getElementById("tab-summary");
  const all = [];
  for (const [cat, items] of Object.entries(results)) for (const r of items) all.push({ ...r, _cat: cat });
  const counts = { fail: 0, warn: 0, pass: 0, info: 0, skip: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;

  const fails = all.filter((r) => r.status === "fail");
  const warns = all.filter((r) => r.status === "warn");
  const working = all.filter((r) => r.status === "pass");

  let health, healthClass;
  if (counts.fail > 0) { health = "Needs attention"; healthClass = "fail"; }
  else if (counts.warn > 0) { health = "Mostly good — a few warnings"; healthClass = "warn"; }
  else if (counts.pass > 0) { health = "Looks good"; healthClass = "pass"; }
  else { health = "Collecting data…"; healthClass = "info"; }

  const headline = `<div class="healthbox health-${healthClass}">
    <div class="health-title">${health}</div>
    <div class="health-sub">
      <strong>${counts.fail}</strong> problem${counts.fail === 1 ? "" : "s"} ·
      <strong>${counts.warn}</strong> warning${counts.warn === 1 ? "" : "s"} ·
      <strong>${counts.pass}</strong> check${counts.pass === 1 ? "" : "s"} passing
    </div>
  </div>`;

  const piiFail = (piiFindings || []).filter((f) => f.severity === "fail").length;
  const piiWarn = (piiFindings || []).filter((f) => f.severity === "warn").length;
  const piiTeaser = (piiFail || piiWarn) ? `<div class="pii-teaser ${piiFail ? "fail" : "warn"}">
    <strong>${piiFail ? `${piiFail} PII violation${piiFail === 1 ? "" : "s"} detected` : `${piiWarn} potential PII issue${piiWarn === 1 ? "" : "s"}`}</strong>
    — raw personal data is being sent to tag vendors.
    <a href="#" data-goto="userdata">Open User data tab →</a>
  </div>` : "";

  const issueItem = (r, icon) => {
    const f = friendlyFor(r);
    return `<li class="plain-item status-${r.status}">
      <span class="plain-icon">${icon}</span>
      <div class="plain-body">
        <div class="plain-text">${escapeHtml(f.text)}</div>
        ${f.why ? `<div class="plain-why">${escapeHtml(f.why)}</div>` : ""}
      </div>
    </li>`;
  };

  const criticalList = fails.length
    ? `<h3 class="sum-h needs">issues (${fails.length})</h3>
       <ul class="plain-list">${fails.map((r) => issueItem(r, "✕")).join("")}</ul>`
    : "";

  const warningsList = warns.length
    ? `<h3 class="sum-h warnings">Warnings (${warns.length})</h3>
       <ul class="plain-list">${warns.map((r) => issueItem(r, "!")).join("")}</ul>`
    : "";

  const noIssues = !fails.length && !warns.length
    ? `<h3 class="sum-h needs-none">No issues found.</h3>`
    : "";

  const workingList = working.length
    ? `<h3 class="sum-h good">What's working well (${working.length})</h3>
       <ul class="plain-list">
         ${working.map((r) => {
           const f = friendlyFor(r);
           return `<li class="plain-item status-pass">
             <span class="plain-icon">✓</span>
             <div class="plain-body"><div class="plain-text">${escapeHtml(f.text)}</div></div>
           </li>`;
         }).join("")}
       </ul>`
    : "";

  const detailsOrder = ["fail", "warn", "pass", "info"];
  const detailsBody = detailsOrder.map((status) => {
    const items = all.filter((r) => r.status === status);
    if (!items.length) return "";
    const label = status === "fail" ? "ISSUES" : status.toUpperCase();
    return `<div class="category status-${status}">${label} · ${items.length}</div>` + items.map(renderRule).join("");
  }).join("");
  const details = `<details class="tech-details">
    <summary>Show technical audit details</summary>
    <div class="tech-details-body">${detailsBody}</div>
  </details>`;

  el.innerHTML = headline + piiTeaser + criticalList + warningsList + noIssues + workingList + details;
  el.querySelectorAll(".rule").forEach((r) => {
    r.querySelector(".hd").addEventListener("click", () => r.classList.toggle("open"));
  });
  el.querySelectorAll("[data-goto]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const target = a.dataset.goto;
      const btn = document.querySelector(`.tabs button[data-tab="${target}"]`);
      if (btn) btn.click();
    });
  });
}

function renderRule(r) {
  const ev = escapeHtml(JSON.stringify(r.evidence, null, 2));
  const cat = r._cat ? `<span class="cat-tag">${escapeHtml(r._cat)}</span>` : "";
  return `<div class="rule" data-status="${r.status}">
    <div class="hd">
      ${cat}
      <span class="title">${escapeHtml(r.title)}</span>
      <span class="sev">${r.severity}</span>
      <span class="status-pill">${r.status}</span>
    </div>
    <div class="rule-body"><pre>${ev}</pre></div>
  </div>`;
}

function renderRequests(annotated) {
  const el = document.getElementById("tab-requests");
  const allRelevant = annotated.filter((r) => r.provider);
  const filtered = requestCategoryFilter
    ? allRelevant.filter((r) => r.provider?.category === requestCategoryFilter)
    : allRelevant;

  const catTitle = { analytics: "Analytics", ads: "Ads", replay: "Session replay", loader: "Tag loaders" };
  const filterBanner = requestCategoryFilter
    ? `<div class="req-filter-banner">
        <span>Filtered by <strong>${catTitle[requestCategoryFilter] || requestCategoryFilter}</strong> · ${filtered.length} of ${allRelevant.length} requests</span>
        <button type="button" id="req-clear-filter">× Clear filter</button>
      </div>`
    : "";

  const isActive = (c) => requestCategoryFilter === c ? " legend-active" : "";
  const legend = `<div class="legend">
    <span class="provider-tag ads legend-click${isActive("ads")}" data-legend-cat="ads" title="Filter by Ads">ads</span>
    <span class="provider-tag analytics legend-click${isActive("analytics")}" data-legend-cat="analytics" title="Filter by Analytics">analytics</span>
    <span class="provider-tag replay legend-click${isActive("replay")}" data-legend-cat="replay" title="Filter by Session replay">session replay</span>
    <span class="provider-tag loader legend-click${isActive("loader")}" data-legend-cat="loader" title="Filter by Tag loaders">loader</span>
    <span class="legend-hint">Click a tag to filter. Only tag / pixel / analytics requests are shown.</span>
  </div>`;
  const wireLegend = () => {
    el.querySelectorAll("[data-legend-cat]").forEach((node) => {
      node.addEventListener("click", () => {
        const cat = node.dataset.legendCat;
        requestCategoryFilter = (requestCategoryFilter === cat) ? null : cat;
        renderRequests(annotated);
      });
    });
    const clearBtn = el.querySelector("#req-clear-filter");
    if (clearBtn) clearBtn.addEventListener("click", () => { requestCategoryFilter = null; renderRequests(annotated); });
  };

  if (!filtered.length) {
    el.innerHTML = filterBanner + legend + "<p>No tag / analytics / ad requests captured yet.</p>";
    wireLegend();
    return;
  }
  const rows = filtered.slice().reverse().map((r) => `
    <tr>
      <td>${new Date(r.timeStamp).toLocaleTimeString()}</td>
      <td><span class="provider-tag ${r.provider.category}">${escapeHtml(r.provider.name)}</span></td>
      <td><code>${escapeHtml(summarizeFields(r.fields))}</code></td>
      <td>${r.status || ""}</td>
      <td><code title="${escapeHtml(r.url)}">${escapeHtml(truncate(r.url, 80))}</code></td>
    </tr>`).join("");
  el.innerHTML = filterBanner + legend + `<table>
    <thead><tr><th>Time</th><th>Provider</th><th>Fields</th><th>Status</th><th>URL</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  wireLegend();
}

function summarizeFields(f) {
  if (!f) return "";
  const keep = [];
  for (const k of ["tid", "id", "ti", "pid", "en", "ev", "event", "awId", "label", "value", "currency", "gcs", "gcd"]) {
    if (f[k]) keep.push(`${k}=${f[k]}`);
  }
  if (Array.isArray(f.events) && f.events.length) keep.push(`events=${f.events.map((e) => e.en).filter(Boolean).join(",")}`);
  return keep.join(" ");
}

const GTM_EVENT_LABELS = {
  "gtm.js": "GTM container started",
  "gtm.dom": "DOM ready",
  "gtm.load": "Page fully loaded",
  "gtm.click": "Element clicked",
  "gtm.linkClick": "Link clicked",
  "gtm.formSubmit": "Form submitted",
  "gtm.historyChange": "URL changed (SPA navigation)",
  "gtm.scrollDepth": "User scrolled",
  "gtm.video": "Video interaction",
  "gtm.elementVisibility": "Element became visible",
  "gtm.timer": "Timer fired"
};

function shortVal(v) {
  if (v == null) return "";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length} items]` : "{…}";
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

function summarizeObject(o, exclude = []) {
  const keys = Object.keys(o).filter((k) => !exclude.includes(k));
  if (!keys.length) return "";
  return keys.slice(0, 4).map((k) => `${k}: ${shortVal(o[k])}`).join(" · ");
}

function classifyPush(e) {
  if (!e || typeof e !== "object") return { kind: "unknown", title: "Unknown push", summary: "", icon: "·" };

  // gtag() arguments — objects whose keys are all numeric strings (e.g. {"0":"consent","1":"update","2":{...}})
  const keys = Object.keys(e);
  const isGtagArgs = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (isGtagArgs) {
    const cmd = e["0"];
    const arg1 = e["1"];
    const arg2 = e["2"];
    if (cmd === "consent") {
      const stage = arg1 || "";
      const cats = arg2 && typeof arg2 === "object" ? arg2 : {};
      const granted = Object.entries(cats).filter(([, v]) => v === "granted").map(([k]) => k);
      const denied = Object.entries(cats).filter(([, v]) => v === "denied").map(([k]) => k);
      const parts = [];
      if (granted.length) parts.push(`Granted: ${granted.join(", ")}`);
      if (denied.length) parts.push(`Denied: ${denied.join(", ")}`);
      return { kind: "consent", title: `Consent ${stage}`, summary: parts.join(" · ") || "No categories set", icon: "🔒" };
    }
    if (cmd === "config") {
      const id = arg1 || "";
      let vendor = "Google tag";
      if (/^G-/.test(id)) vendor = "GA4";
      else if (/^AW-/.test(id)) vendor = "Google Ads";
      else if (/^GT-/.test(id)) vendor = "Google Tag";
      else if (/^DC-/.test(id)) vendor = "Floodlight";
      const params = arg2 && typeof arg2 === "object" ? arg2 : null;
      const extra = params ? summarizeObject(params) : "";
      return { kind: "config", title: `${vendor} configured`, summary: [`ID ${id}`, extra].filter(Boolean).join(" · "), icon: "⚙" };
    }
    if (cmd === "set") {
      const detail = typeof arg1 === "object" ? summarizeObject(arg1) : `${arg1}${arg2 !== undefined ? " = " + shortVal(arg2) : ""}`;
      return { kind: "set", title: "Variable set (gtag)", summary: detail, icon: "·" };
    }
    if (cmd === "event") {
      const params = arg2 && typeof arg2 === "object" ? arg2 : null;
      return { kind: "custom_event", title: `gtag event: ${arg1 || ""}`, summary: params ? summarizeObject(params) : "", icon: "⚡" };
    }
    if (cmd === "js") {
      return { kind: "init", title: "gtag initialized", summary: arg1 ? `at ${arg1}` : "", icon: "▶" };
    }
    return { kind: "gtag", title: `gtag ${cmd || "call"}`, summary: "", icon: "·" };
  }

  // Event-style pushes ({event: "...", ...})
  if (e.event) {
    const ev = e.event;
    if (/^gtm\./.test(ev)) {
      return { kind: "gtm_internal", title: "GTM internal", summary: GTM_EVENT_LABELS[ev] || ev, icon: "·" };
    }
    if (e.ecommerce || /^(purchase|add_to_cart|view_item|begin_checkout|add_payment_info|add_shipping_info|view_cart|remove_from_cart|select_item|view_item_list|refund)$/.test(ev)) {
      const ec = e.ecommerce || e;
      const items = ec.items || ec.products || [];
      const value = ec.value ?? ec.revenue ?? "";
      const currency = ec.currency || "";
      const parts = [];
      if (items.length) parts.push(`${items.length} item${items.length === 1 ? "" : "s"}`);
      if (value !== "") parts.push(`${currency ? currency + " " : ""}${value}`);
      if (ec.transaction_id) parts.push(`txn ${ec.transaction_id}`);
      return { kind: "ecommerce", title: `Ecommerce: ${ev}`, summary: parts.join(" · ") || "No items captured", icon: "🛒" };
    }
    if (/consent/i.test(ev)) {
      return { kind: "consent", title: `Consent event: ${ev}`, summary: summarizeObject(e, ["event"]), icon: "🔒" };
    }
    return { kind: "custom_event", title: `Event: ${ev}`, summary: summarizeObject(e, ["event"]), icon: "⚡" };
  }

  // Plain variable push (no event, no gtag-args)
  return { kind: "variable", title: "Variable set", summary: summarizeObject(e), icon: "·" };
}

const KIND_LABELS = {
  consent: "Consent", config: "Config", set: "Set", init: "Init", gtag: "gtag",
  gtm_internal: "GTM", custom_event: "Event", ecommerce: "Ecommerce",
  variable: "Variable", unknown: "Push"
};

function renderDataLayer(pushes) {
  const el = document.getElementById("tab-datalayer");
  if (!pushes.length) { el.innerHTML = "<p>No dataLayer pushes captured.</p>"; return; }

  const showInternals = el.dataset.showInternals === "1";
  const classified = pushes.slice().reverse().map((p) => ({ ...p, c: classifyPush(p.e) }));
  const gtmCount = classified.filter((p) => p.c.kind === "gtm_internal").length;
  const visible = classified.filter((p) => showInternals || p.c.kind !== "gtm_internal");

  const toolbar = `<div class="dl-toolbar">
    <label class="dl-toggle"><input type="checkbox" id="dl-internals" ${showInternals ? "checked" : ""}/> Show GTM internals (${gtmCount} hidden)</label>
    <span class="dl-count">${visible.length} of ${pushes.length} pushes</span>
  </div>`;

  const rows = visible.map((p) => {
    const { kind, title, summary, icon } = p.c;
    return `<div class="dl-item kind-${kind}">
      <div class="dl-time">${new Date(p.t).toLocaleTimeString()}</div>
      <div class="dl-icon">${escapeHtml(icon || "·")}</div>
      <div class="dl-main">
        <div class="dl-title-row">
          <span class="dl-kind kind-${kind}">${KIND_LABELS[kind] || kind}</span>
          <span class="dl-title">${escapeHtml(title)}</span>
        </div>
        ${summary ? `<div class="dl-summary">${escapeHtml(summary)}</div>` : ""}
      </div>
      <button class="dl-toggle-json" type="button">View raw</button>
      <pre class="dl-json">${escapeHtml(JSON.stringify(p.e, null, 2))}</pre>
    </div>`;
  }).join("");

  el.innerHTML = toolbar + (rows || "<p>No pushes match the current filter.</p>");

  const cb = el.querySelector("#dl-internals");
  if (cb) cb.addEventListener("change", (ev) => {
    el.dataset.showInternals = ev.target.checked ? "1" : "0";
    renderDataLayer(pushes);
  });

  el.querySelectorAll(".dl-toggle-json").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".dl-item");
      item.classList.toggle("open");
      btn.textContent = item.classList.contains("open") ? "Hide raw" : "View raw";
    });
  });
}

function renderCookies(cookies) {
  const el = document.getElementById("tab-cookies");
  if (!cookies.length) { el.innerHTML = "<p>No cookies for this origin.</p>"; return; }
  const rows = cookies.map((c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.domain)}</td>
      <td>${escapeHtml(c.path)}</td>
      <td>${c.secure}</td>
      <td>${c.httpOnly}</td>
      <td>${c.sameSite || ""}</td>
      <td>${c.session ? "session" : (c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10) : "")}</td>
    </tr>`).join("");
  el.innerHTML = `<table><thead><tr><th>Name</th><th>Domain</th><th>Path</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPageState(ps) {
  const el = document.getElementById("tab-pagestate");
  el.innerHTML = `<pre>${escapeHtml(JSON.stringify(ps, null, 2))}</pre>`;
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function truncate(s, n) { return (s || "").length > n ? s.slice(0, n) + "…" : s || ""; }

// Live wiring — connects to the service-worker, receives snapshot + deltas, and re-runs audits on debounce.
connectLive();
setTimeout(runAudit, 300);

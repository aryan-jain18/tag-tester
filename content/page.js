// Runs in the page's main world. Reads dataLayer, google_tag_manager, CMP globals,
// click IDs from URL, persisted UTMs in localStorage. Relays via window.postMessage
// (the content script bridges to the service worker).

(function () {
  const pushes = [];
  const MAX = 500;

  function send(patch) {
    window.postMessage({ __ttSource: "tag-tester-page", payload: patch }, "*");
  }

  // --- dataLayer capture (Data Slayer style) ---
  try {
    const existing = Array.isArray(window.dataLayer) ? window.dataLayer.slice() : [];
    for (const e of existing) pushes.push({ t: Date.now(), e: safeClone(e) });
    if (!window.dataLayer) window.dataLayer = [];
    const origPush = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function (...args) {
      for (const a of args) {
        pushes.push({ t: Date.now(), e: safeClone(a) });
        if (pushes.length > MAX) pushes.shift();
      }
      const ret = origPush(...args);
      send({ dataLayer: pushes.slice(-200) });
      return ret;
    };
  } catch {}

  // --- Click IDs in URL ---
  function readClickIds() {
    const ids = {};
    try {
      const q = new URLSearchParams(location.search);
      for (const k of ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid", "yclid"]) {
        const v = q.get(k); if (v) ids[k] = v;
      }
    } catch {}
    return ids;
  }

  // --- UTM persistence in localStorage ---
  function readUtmPersistence() {
    const found = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/utm|campaign|source|medium/i.test(k)) {
          found[k] = String(localStorage.getItem(k) || "").slice(0, 200);
        }
      }
    } catch {}
    return found;
  }

  // --- CMP detection ---
  function readCmp() {
    const cmp = { framework: null, apis: [], tcf: null };
    try {
      if (typeof window.__tcfapi === "function") { cmp.apis.push("__tcfapi"); cmp.framework = cmp.framework || "tcf-v2"; }
      if (typeof window.__uspapi === "function") cmp.apis.push("__uspapi");
      if (typeof window.__gppapi === "function") cmp.apis.push("__gppapi");
      if (window.OneTrust || window.Optanon) cmp.framework = "onetrust";
      else if (window.Cookiebot) cmp.framework = "cookiebot";
      else if (window.Didomi) cmp.framework = "didomi";
      else if (window.UC_UI || window.usercentrics) cmp.framework = "usercentrics";
      else if (window.CookieConsent || window.cookieconsent) cmp.framework = cmp.framework || "cookieconsent";
      else if (window.cookieyes || window.CookieYes) cmp.framework = "cookieyes";
      // Consent Mode v2 default state (best-effort — most sites set via gtag('consent','default',...))
      if (Array.isArray(window.dataLayer)) {
        for (const e of window.dataLayer) {
          if (Array.isArray(e) && e[0] === "consent") {
            cmp.consentCalls = (cmp.consentCalls || []).concat([{ stage: e[1], params: safeClone(e[2]) }]);
          }
        }
      }
    } catch {}
    return cmp;
  }

  // --- Google Tag Manager object (container IDs) ---
  function readGtm() {
    const out = { containers: [] };
    try {
      const gtm = window.google_tag_manager;
      if (gtm && typeof gtm === "object") {
        for (const k of Object.keys(gtm)) if (/^GTM-|^G-|^AW-|^DC-/.test(k)) out.containers.push(k);
      }
    } catch {}
    return out;
  }

  function sendSnapshot() {
    send({
      url: location.href,
      origin: location.origin,
      host: location.hostname,
      timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      userAgent: navigator.userAgent,
      dataLayer: pushes.slice(-200),
      clickIds: readClickIds(),
      utmStorage: readUtmPersistence(),
      cmp: readCmp(),
      gtm: readGtm(),
      capturedAt: Date.now()
    });
  }

  function safe(fn) { try { return fn(); } catch { return null; } }
  function safeClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch { return String(o); } }

  sendSnapshot();
  // Re-snapshot on load + periodically for late-binding CMPs/containers.
  window.addEventListener("DOMContentLoaded", sendSnapshot);
  window.addEventListener("load", () => { sendSnapshot(); setTimeout(sendSnapshot, 1500); setTimeout(sendSnapshot, 4000); });
})();

// Injected into page MAIN world to capture dataLayer, console messages, and CWV.
(function () {
  if (window.__GTM_AUDIT_INJECTED__) return;
  window.__GTM_AUDIT_INJECTED__ = true;

  const bus = new EventTarget();
  window.__gtmAuditBus = bus;

  function send(kind, payload) {
    window.postMessage({ __gtmAudit: true, kind, payload }, "*");
  }

  // ---- dataLayer hook (Data Slayer style) ----
  function hookDataLayer(name) {
    try {
      const existing = window[name];
      const arr = Array.isArray(existing) ? existing : [];
      window[name] = arr;
      // Emit historical pushes
      arr.forEach((item, i) => send("datalayer-push", { name, index: i, value: safeClone(item), historical: true }));
      const origPush = arr.push.bind(arr);
      arr.push = function (...args) {
        const res = origPush(...args);
        for (const a of args) send("datalayer-push", { name, value: safeClone(a), ts: Date.now() });
        return res;
      };
    } catch (e) { /* ignore */ }
  }
  hookDataLayer("dataLayer");        // GTM
  hookDataLayer("digitalData");      // Adobe/CEDDL
  hookDataLayer("_satellite_dataLayer"); // Adobe Launch (informal)

  // Observe newly created arrays with these names
  const dlNames = ["dataLayer", "digitalData"];
  const origDefine = Object.defineProperty;
  // best-effort periodic check
  setInterval(() => {
    dlNames.forEach(n => {
      if (Array.isArray(window[n]) && !window[n].__gtmAuditHooked) {
        window[n].__gtmAuditHooked = true;
        hookDataLayer(n);
      }
    });
  }, 1500);

  function safeClone(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
  }

  // ---- Console capture ----
  ["error", "warn"].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      try {
        send("console", {
          level,
          message: args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
          }).join(" "),
          ts: Date.now()
        });
      } catch {}
      return orig(...args);
    };
  });
  window.addEventListener("error", (e) => {
    send("console", { level: "error", message: (e.error && e.error.stack) || e.message || "Uncaught error", ts: Date.now(), source: e.filename });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send("console", { level: "error", message: "UnhandledRejection: " + ((r && r.stack) || (r && r.message) || String(r)), ts: Date.now() });
  });

  // ---- Core Web Vitals (lightweight) ----
  const cwv = { LCP: null, CLS: 0, INP: null, FCP: null, TTFB: null };
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) cwv.TTFB = Math.round(nav.responseStart);
  } catch {}
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      cwv.LCP = Math.round(last.renderTime || last.loadTime || last.startTime);
      send("cwv", cwv);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) cwv.CLS += e.value;
      }
      send("cwv", cwv);
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === "first-contentful-paint") cwv.FCP = Math.round(e.startTime);
      }
      send("cwv", cwv);
    }).observe({ type: "paint", buffered: true });
  } catch {}
  // Approx INP via event timing
  try {
    let worst = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const d = e.duration;
        if (d > worst) { worst = d; cwv.INP = Math.round(d); send("cwv", cwv); }
      }
    }).observe({ type: "event", durationThreshold: 40, buffered: true });
  } catch {}

  // ---- Storage snapshot on request ----
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || !m.__gtmAuditCmd) return;
    if (m.cmd === "snapshot-storage") {
      const local = {}, session = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); local[k] = localStorage.getItem(k); } } catch {}
      try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); session[k] = sessionStorage.getItem(k); } } catch {}
      let idbDbs = [];
      try {
        if (indexedDB.databases) {
          indexedDB.databases().then(list => {
            idbDbs = (list || []).map(d => d.name).filter(Boolean);
            send("storage", { local, session, idbDbs });
          }).catch(() => send("storage", { local, session, idbDbs }));
          return;
        }
      } catch {}
      send("storage", { local, session, idbDbs });
    } else if (m.cmd === "get-resource-timing") {
      const entries = (performance.getEntriesByType("resource") || []).map(e => ({
        name: e.name, initiatorType: e.initiatorType,
        duration: Math.round(e.duration), startTime: Math.round(e.startTime),
        transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize,
        dns: Math.round(e.domainLookupEnd - e.domainLookupStart),
        tcp: Math.round(e.connectEnd - e.connectStart),
        ttfb: Math.round(e.responseStart - e.requestStart),
        nextHopProtocol: e.nextHopProtocol
      }));
      send("resource-timing", entries);
    }
  });

  send("ready", { ts: Date.now() });
})();

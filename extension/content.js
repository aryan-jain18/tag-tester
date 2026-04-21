// Content script: bridges page <-> extension, runs DOM scans.
(function () {
  // injected.js is loaded into MAIN world by the background via chrome.scripting.
  // This content script runs in the ISOLATED world and only bridges messages.

  const buffer = { dataLayer: [], console: [], cwv: null, storage: null, resourceTiming: [] };

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || !m.__gtmAudit) return;
    if (m.kind === "datalayer-push") buffer.dataLayer.push(m.payload);
    else if (m.kind === "console") buffer.console.push(m.payload);
    else if (m.kind === "cwv") buffer.cwv = m.payload;
    else if (m.kind === "storage") buffer.storage = m.payload;
    else if (m.kind === "resource-timing") buffer.resourceTiming = m.payload;
    // Cap
    if (buffer.dataLayer.length > 2000) buffer.dataLayer.splice(0, 500);
    if (buffer.console.length > 2000) buffer.console.splice(0, 500);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "scan-dom") {
          sendResponse({ ok: true, data: scanDom() });
        } else if (msg?.type === "get-buffer") {
          sendResponse({ ok: true, data: buffer });
        } else if (msg?.type === "snapshot-storage") {
          window.postMessage({ __gtmAuditCmd: true, cmd: "snapshot-storage" }, "*");
          await wait(400);
          sendResponse({ ok: true, data: buffer.storage });
        } else if (msg?.type === "resource-timing") {
          window.postMessage({ __gtmAuditCmd: true, cmd: "get-resource-timing" }, "*");
          await wait(250);
          sendResponse({ ok: true, data: buffer.resourceTiming });
        } else {
          sendResponse({ ok: false, error: "unknown" });
        }
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  });

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function scanDom() {
    const doc = document;
    const head = doc.head;
    const getMeta = (sel) => doc.querySelector(sel)?.getAttribute("content") || null;
    const metas = {
      viewport: getMeta('meta[name="viewport"]'),
      description: getMeta('meta[name="description"]'),
      canonical: doc.querySelector('link[rel="canonical"]')?.href || null,
      ogTitle: getMeta('meta[property="og:title"]'),
      ogImage: getMeta('meta[property="og:image"]'),
      ogDescription: getMeta('meta[property="og:description"]'),
      twitterCard: getMeta('meta[name="twitter:card"]'),
      robots: getMeta('meta[name="robots"]'),
      title: doc.title || null
    };
    const scripts = Array.from(doc.scripts).map(s => ({
      src: s.src || null, async: s.async, defer: s.defer, inHead: !!(head && head.contains(s)),
      type: s.type || "", inline: !s.src ? (s.textContent || "").length : 0
    }));
    const images = Array.from(doc.images).map(i => ({
      src: i.currentSrc || i.src, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, loading: i.loading
    }));
    const iframes = Array.from(doc.querySelectorAll("iframe")).map(f => ({
      src: f.src || null, sandbox: f.sandbox?.value || null, name: f.name || null
    }));
    const stylesheets = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map(l => ({
      href: l.href, media: l.media, inHead: !!(head && head.contains(l)), disabled: l.disabled
    }));
    // Rough API-key surface: scan inline scripts
    const keyPatterns = [
      { name: "Stripe publishable key", re: /pk_(live|test)_[A-Za-z0-9]{16,}/g },
      { name: "Stripe secret key", re: /sk_(live|test)_[A-Za-z0-9]{16,}/g },
      { name: "Google API key", re: /AIza[0-9A-Za-z\-_]{35}/g },
      { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
      { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
      { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
      { name: "HubSpot portal", re: /hubspot[^\"'<>]{0,20}[\"']?[0-9]{5,}/gi }
    ];
    const keyHits = [];
    const inlineText = Array.from(doc.scripts).filter(s => !s.src).map(s => s.textContent || "").join("\n");
    const sampleHtml = doc.documentElement.outerHTML.slice(0, 400000);
    for (const kp of keyPatterns) {
      const s = new Set();
      (inlineText.match(kp.re) || []).forEach(x => s.add(x));
      (sampleHtml.match(kp.re) || []).forEach(x => s.add(x));
      if (s.size) keyHits.push({ name: kp.name, samples: Array.from(s).slice(0, 5) });
    }
    return { metas, scripts, images, iframes, stylesheets, keyHits, url: location.href, origin: location.origin, host: location.hostname };
  }
})();

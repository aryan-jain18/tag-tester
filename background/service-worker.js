// Per-tab request capture + page-state relay for the Tag Tester devtools panel.

const tabs = new Map(); // tabId -> { requests: [], pageState: {}, origin: "" }
const ports = new Map(); // tabId -> Set<Port>

function bucket(tabId) {
  let b = tabs.get(tabId);
  if (!b) { b = { requests: [], pageState: {}, origin: "" }; tabs.set(tabId, b); }
  return b;
}

function resetTab(tabId) {
  tabs.set(tabId, { requests: [], pageState: {}, origin: "" });
  broadcast(tabId, { type: "snapshot", requests: [], pageState: {}, origin: "" });
}

function broadcast(tabId, msg) {
  const set = ports.get(tabId);
  if (!set) return;
  for (const p of set) { try { p.postMessage(msg); } catch {} }
}

chrome.runtime.onConnect.addListener((port) => {
  const m = /^tt-panel-(-?\d+)$/.exec(port.name || "");
  if (!m) return;
  const tabId = parseInt(m[1], 10);
  if (!ports.has(tabId)) ports.set(tabId, new Set());
  ports.get(tabId).add(port);
  const b = bucket(tabId);
  try { port.postMessage({ type: "snapshot", requests: b.requests, pageState: b.pageState, origin: b.origin }); } catch {}
  port.onDisconnect.addListener(() => {
    const set = ports.get(tabId);
    if (set) { set.delete(port); if (!set.size) ports.delete(tabId); }
  });
});

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) resetTab(d.tabId);
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const b = bucket(details.tabId);
    const postBody = extractPostBody(details.requestBody);
    const r = {
      id: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      timeStamp: details.timeStamp,
      initiator: details.initiator || "",
      postBody
    };
    b.requests.push(r);
    if (b.requests.length > 3000) b.requests.shift();
    broadcast(details.tabId, { type: "request", r });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const b = bucket(details.tabId);
    const r = b.requests.find((x) => x.id === details.requestId);
    if (r) {
      r.status = details.statusCode;
      r.responseHeaders = details.responseHeaders || [];
      r.fromCache = details.fromCache;
      broadcast(details.tabId, { type: "requestUpdate", id: details.requestId, patch: { status: r.status, fromCache: r.fromCache } });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function extractPostBody(rb) {
  if (!rb) return null;
  if (rb.formData) {
    const parts = [];
    for (const [k, vs] of Object.entries(rb.formData)) for (const v of vs) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return parts.join("&");
  }
  if (rb.raw && rb.raw.length) {
    try {
      const dec = new TextDecoder("utf-8");
      return rb.raw.map((p) => (p.bytes ? dec.decode(p.bytes) : "")).join("");
    } catch { return null; }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TT_PAGE_STATE" && sender.tab) {
    const b = bucket(sender.tab.id);
    b.pageState = { ...b.pageState, ...msg.payload };
    if (sender.tab.url) { try { b.origin = new URL(sender.tab.url).origin; } catch {} }
    broadcast(sender.tab.id, { type: "pageState", pageState: b.pageState, origin: b.origin });
    return;
  }
  if (msg?.type === "TT_GET_COOKIES" && typeof msg.tabId === "number") {
    const b = bucket(msg.tabId);
    let host = "";
    try { host = b.origin ? new URL(b.origin).hostname : ""; } catch {}
    chrome.cookies.getAll({}, (all) => {
      const cookies = all.filter((c) => {
        const d = c.domain.replace(/^\./, "");
        return host && (host === d || host.endsWith("." + d));
      });
      sendResponse({ cookies });
    });
    return true;
  }
  if (msg?.type === "TT_GET_CONTEXT" && typeof msg.tabId === "number") {
    const b = bucket(msg.tabId);
    chrome.cookies.getAll({}, (allCookies) => {
      let host = "";
      try { host = b.origin ? new URL(b.origin).hostname : ""; } catch {}
      const cookies = allCookies.filter((c) => host && (c.domain === host || host.endsWith(c.domain.replace(/^\./, ""))));
      sendResponse({
        requests: b.requests,
        pageState: b.pageState,
        origin: b.origin,
        host,
        cookies
      });
    });
    return true;
  }
  if (msg?.type === "TT_CLEAR_TAB" && typeof msg.tabId === "number") {
    resetTab(msg.tabId);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "TT_CLEAR_COOKIES" && typeof msg.tabId === "number") {
    chrome.tabs.get(msg.tabId, async (tab) => {
      if (!tab?.url) return sendResponse({ ok: false });
      const origin = new URL(tab.url).origin;
      const host = new URL(tab.url).hostname;
      const all = await chrome.cookies.getAll({});
      const scoped = msg.scope === "tracking" ? TRACKING_COOKIE_PATTERNS : null;
      let removed = 0;
      for (const c of all) {
        const d = c.domain.replace(/^\./, "");
        if (!(host === d || host.endsWith("." + d))) continue;
        if (scoped && !scoped.some((re) => re.test(c.name))) continue;
        const url = `http${c.secure ? "s" : ""}://${d}${c.path}`;
        try { await chrome.cookies.remove({ url, name: c.name }); removed++; } catch {}
      }
      if (msg.alsoStorage) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: msg.tabId },
            func: () => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }
          });
        } catch {}
      }
      sendResponse({ ok: true, removed, origin });
    });
    return true;
  }
});

const TRACKING_COOKIE_PATTERNS = [
  /^_ga(_|$)/, /^_gid$/, /^_gcl_/, /^_gac_/, /^_fbp$/, /^_fbc$/,
  /^_uetsid/, /^_uetvid/, /^_ttp$/, /^li_fat_id$/, /^lidc$/, /^bcookie$/,
  /^_pin_/, /^_hjS/, /^_hjid/, /^mp_/, /^ajs_/, /^amplitude_/,
  /OptanonConsent/i, /CookieConsent/i, /euconsent/i, /didomi/i, /OneTrust/i,
  /usercentrics/i, /cookieyes/i
];

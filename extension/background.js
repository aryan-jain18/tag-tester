// Service worker: network capture + per-tab state + message routing.
try { importScripts("lib/providers.js"); } catch (e) { console.error("providers load failed", e); }

const tabState = new Map(); // tabId -> { requests: [], cookiesSeen: Set, origin: "" }

function getState(tabId) {
  if (!tabState.has(tabId)) tabState.set(tabId, {
    requests: [],
    consentDenied: false,
    origin: "",
    createdAt: Date.now()
  });
  return tabState.get(tabId);
}

function resetState(tabId) {
  tabState.set(tabId, { requests: [], consentDenied: false, origin: "", createdAt: Date.now() });
}

// Capture outgoing requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const st = getState(details.tabId);
    let postBody = "";
    if (details.requestBody) {
      if (details.requestBody.raw) {
        try {
          postBody = details.requestBody.raw.map(r => {
            try { return new TextDecoder().decode(r.bytes); } catch { return ""; }
          }).join("");
        } catch {}
      } else if (details.requestBody.formData) {
        try { postBody = new URLSearchParams(details.requestBody.formData).toString(); } catch {}
      }
    }
    const provider = (self.matchProvider ? self.matchProvider(details.url) : null);
    st.requests.push({
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      timeStamp: details.timeStamp,
      postBody,
      provider: provider ? { key: provider.key, name: provider.name, category: provider.category, fields: tryParse(provider, details.url, postBody) } : null,
      status: null,
      statusLine: null,
      responseHeaders: null,
      fromCache: false
    });
    // Cap memory
    if (st.requests.length > 4000) st.requests.splice(0, 500);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

function tryParse(p, url, body) { try { return p.parse(url, body) || {}; } catch { return {}; } }

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const st = getState(details.tabId);
    const req = st.requests.find(r => r.id === details.requestId);
    if (req) {
      req.status = details.statusCode;
      req.statusLine = details.statusLine;
      req.responseHeaders = details.responseHeaders || [];
      req.fromCache = !!details.fromCache;
      req.ip = details.ip;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const st = getState(details.tabId);
    const req = st.requests.find(r => r.id === details.requestId);
    if (req) { req.error = details.error; req.status = 0; }
  },
  { urls: ["<all_urls>"] }
);

// Reset state on top-frame navigation (webNavigation is optional)
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId === 0) resetState(d.tabId);
  });
}
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) {
      const st = getState(d.tabId);
      try { st.origin = new URL(d.url).origin; } catch {}
    }
  });
}

// Messaging
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "get-requests") {
        const tabId = msg.tabId ?? sender.tab?.id;
        const st = getState(tabId);
        sendResponse({ ok: true, requests: st.requests, origin: st.origin, consentDenied: st.consentDenied });
      } else if (msg?.type === "clear-requests") {
        resetState(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg?.type === "set-consent-denied") {
        getState(msg.tabId).consentDenied = !!msg.denied;
        sendResponse({ ok: true });
      } else if (msg?.type === "get-cookies") {
        const cookies = await chrome.cookies.getAll({ url: msg.url });
        sendResponse({ ok: true, cookies });
      } else if (msg?.type === "clear-page-storage") {
        // Runs in MAIN world to clear localStorage + sessionStorage of the page.
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, allFrames: false },
          world: "MAIN",
          func: () => { try { localStorage.clear(); } catch (e) {} try { sessionStorage.clear(); } catch (e) {} }
        });
        sendResponse({ ok: true });
      } else if (msg?.type === "clear-cookies-for-url") {
        const cookies = await chrome.cookies.getAll({ url: msg.url });
        for (const c of cookies) {
          const proto = c.secure ? "https://" : "http://";
          const cookieUrl = proto + (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain) + c.path;
          try { await chrome.cookies.remove({ url: cookieUrl, name: c.name, storeId: c.storeId }); } catch {}
        }
        sendResponse({ ok: true, removed: cookies.length });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

// Inject the MAIN-world script on every top-frame commit using the scripting API.
// This avoids CSP violations on strict sites where appending <script src=chrome-extension://...> is blocked.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    if (!/^https?:/.test(d.url)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: d.tabId, frameIds: [0] },
        world: "MAIN",
        files: ["injected.js"],
        injectImmediately: true
      });
    } catch (e) { /* ignored (e.g., chrome:// pages) */ }
  });
}

// Content script. Injects page.js into the MAIN world so it can read
// dataLayer / google_tag_manager / CMP globals, then relays to the service worker.

(function () {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/page.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch {}

  const onMessage = (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ttSource !== "tag-tester-page") return;
    // The extension can be reloaded/updated while this old page still runs.
    // `chrome.runtime` then throws synchronously — catch it and unhook the listener.
    try {
      if (!chrome.runtime?.id) throw new Error("context invalidated");
      const p = chrome.runtime.sendMessage({ type: "TT_PAGE_STATE", payload: d.payload });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      window.removeEventListener("message", onMessage);
    }
  };
  window.addEventListener("message", onMessage);
})();

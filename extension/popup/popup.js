const statusEl = document.getElementById("status");
function setStatus(s) { statusEl.textContent = s; }

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

document.getElementById("clearCookies").addEventListener("click", async () => {
  const t = await currentTab();
  if (!t?.url) return;
  const resp = await chrome.runtime.sendMessage({ type: "clear-cookies-for-url", url: t.url });
  setStatus(`Removed ${resp?.removed ?? 0} cookies.`);
});

document.getElementById("clearStorage").addEventListener("click", async () => {
  const t = await currentTab();
  if (!t?.id) return;
  chrome.runtime.sendMessage({ type: "clear-page-storage", tabId: t.id }, () => setStatus("Cleared localStorage/sessionStorage."));
});

// Cookie-hygiene rules — maps to R148–R151.

(function (root) {
  const EU_TIMEZONES = /^(Europe\/|Atlantic\/(Azores|Canary|Faroe|Madeira|Reykjavik))/;
  const TWO_YEARS_SEC = 60 * 60 * 24 * 365 * 2;

  function run(ctx) {
    const out = [];
    const { cookies, pageState, region } = ctx;
    const isEU = region === "EU" || (region === "auto" && EU_TIMEZONES.test(pageState?.timezone || ""));
    const now = Date.now() / 1000;

    // R148–R149 — Google tags use default 2-year cookie expiry in EU (_ga, _gid, _gcl_*)
    const longLived = (cookies || []).filter((c) => {
      if (!/^_ga(_|$)|^_gcl_|^_gid$/.test(c.name)) return false;
      if (!c.expirationDate) return false;
      return c.expirationDate - now > TWO_YEARS_SEC - 60 * 60 * 24 * 30; // >~23 months
    });
    out.push({
      id: "COOKIES-001", severity: isEU ? "high" : "low",
      status: longLived.length ? (isEU ? "fail" : "warn") : "pass",
      title: "Google tracking cookies use reduced expiry in EU",
      evidence: { longLived: longLived.map((c) => ({ name: c.name, domain: c.domain, daysRemaining: Math.round((c.expirationDate - now) / 86400) })) }
    });

    // R150–R151 — session-only cookies from document.cookie writes without expires/max-age.
    // chrome.cookies API exposes `session: true` for these.
    const sessionOnly = (cookies || []).filter((c) => c.session);
    const trackersSessionOnly = sessionOnly.filter((c) => /^_ga|^_gid|^_fb|^_gcl|^_uet|^_ttp|^lintrk/.test(c.name));
    out.push({
      id: "COOKIES-002", severity: trackersSessionOnly.length ? "medium" : "info",
      status: trackersSessionOnly.length ? "warn" : "pass",
      title: "Tracking cookies have persistent expiry (not session-only)",
      evidence: { total: sessionOnly.length, trackerSessionCookies: trackersSessionOnly.map((c) => c.name) }
    });

    // Overall cookie inventory
    out.push({
      id: "COOKIES-003", severity: "info", status: "info",
      title: "Cookie inventory",
      evidence: {
        total: (cookies || []).length,
        byCategory: categorize(cookies || [])
      }
    });

    return out;
  }

  function categorize(cookies) {
    const counts = { tracking: 0, consent: 0, functional: 0, other: 0 };
    for (const c of cookies) {
      if (/^_ga|^_gid|^_gcl|^_fb|^_uet|^_ttp|^_pin_|^_hj|^li_fat_id|^lidc|^mp_|^ajs_/.test(c.name)) counts.tracking++;
      else if (/Optanon|CookieConsent|euconsent|didomi|OneTrust|usercentrics|cookieyes/i.test(c.name)) counts.consent++;
      else if (/session|csrf|xsrf|auth|token|sid|cart|lang|locale/i.test(c.name)) counts.functional++;
      else counts.other++;
    }
    return counts;
  }

  const api = { run };
  if (typeof module !== "undefined") module.exports = api;
  root.TTRules = root.TTRules || {};
  root.TTRules.cookies = api;
})(typeof window !== "undefined" ? window : self);

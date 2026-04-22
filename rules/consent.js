// Consent & CMP rules — maps to checklist rows R41–R67, R83–R87.

(function (root) {
  const EU_TIMEZONES = /^(Europe\/|Atlantic\/(Azores|Canary|Faroe|Madeira|Reykjavik))/;

  function run(ctx) {
    const out = [];
    const { annotated, pageState, region } = ctx;
    const isEU = region === "EU" || (region === "auto" && EU_TIMEZONES.test(pageState?.timezone || ""));
    const cmp = pageState?.cmp || {};
    const ga4 = annotated.filter((r) => r.provider?.key === "ga4");
    const ads = annotated.filter((r) => r.provider?.category === "ads");
    const replay = annotated.filter((r) => r.provider?.category === "replay");

    // R41 — EU site with no CMP / consent init
    const hasCmp = !!(cmp.framework || (cmp.apis || []).length);
    out.push({
      id: "CONSENT-001", severity: isEU ? "critical" : "info",
      status: hasCmp ? "pass" : (isEU ? "fail" : "warn"),
      title: "CMP framework present",
      evidence: { framework: cmp.framework || null, apis: cmp.apis || [], region: isEU ? "EU" : "non-EU" }
    });

    // R48–R50 — non-Google / Google tags fire without consent signal in EU
    const gaWithGcs = ga4.filter((r) => (r.fields?.gcs || "") !== "");
    out.push({
      id: "CONSENT-002", severity: "critical",
      status: ga4.length === 0 ? "skip" : (gaWithGcs.length === ga4.length ? "pass" : "fail"),
      title: "GA4 hits carry Consent Mode signal (gcs)",
      evidence: { total: ga4.length, withGcs: gaWithGcs.length, missing: ga4.filter((r) => !r.fields?.gcs).length }
    });

    // R51–R54 — Consent Mode v2 categories
    const gaWithV2 = ga4.filter((r) => r.fields?.gcd && /[0-9]/.test(r.fields.gcd));
    out.push({
      id: "CONSENT-003", severity: "high",
      status: ga4.length === 0 ? "skip" : (gaWithV2.length ? "pass" : "warn"),
      title: "Consent Mode v2 present (gcd with ad_user_data / ad_personalization)",
      evidence: { total: ga4.length, withGcd: gaWithV2.length, sampleGcd: gaWithV2[0]?.fields?.gcd || null }
    });

    // R58–R61 — ad tags missing ad_storage category (indirect: any ad request with no CMP + EU)
    if (isEU) {
      const adUngated = ads.filter((r) => !/gcs=|gcd=/.test(r.url));
      out.push({
        id: "CONSENT-004", severity: "critical",
        status: ads.length === 0 ? "skip" : (adUngated.length ? "fail" : "pass"),
        title: "Ad pixels carry consent signal in EU",
        evidence: { totalAds: ads.length, ungated: adUngated.slice(0, 20).map((r) => ({ provider: r.provider?.name, url: truncate(r.url) })) }
      });
    }

    // R83–R87 — session replay gated
    out.push({
      id: "CONSENT-005", severity: isEU ? "high" : "medium",
      status: replay.length === 0 ? "pass" : (hasCmp ? "warn" : "fail"),
      title: "Session replay loads only after consent",
      evidence: { replayProviders: replay.map((r) => r.provider?.name).filter(Boolean).slice(0, 10), cmp: cmp.framework || null }
    });

    // R66–R67 — per-category gating observed
    const consentCalls = (cmp.consentCalls || []).length;
    out.push({
      id: "CONSENT-006", severity: "info",
      status: consentCalls ? "pass" : "info",
      title: "gtag('consent', ...) calls observed in dataLayer",
      evidence: { calls: consentCalls, stages: (cmp.consentCalls || []).map((c) => c.stage) }
    });

    return out;
  }

  function truncate(s, n = 180) { return (s || "").length > n ? s.slice(0, n) + "…" : s || ""; }

  const api = { run };
  if (typeof module !== "undefined") module.exports = api;
  root.TTRules = root.TTRules || {};
  root.TTRules.consent = api;
})(typeof window !== "undefined" ? window : self);

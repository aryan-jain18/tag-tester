// Ad platform rules — maps to R111–R147.

(function (root) {
  function run(ctx) {
    const out = [];
    const { annotated, pageState, cookies } = ctx;
    const byProv = (k) => annotated.filter((r) => r.provider?.key === k);

    const googleAds = byProv("google_ads_conv");
    const floodlight = byProv("floodlight");
    const meta = byProv("meta");
    const tiktok = byProv("tiktok");
    const linkedin = byProv("linkedin");
    const bing = byProv("bing");
    const conversionLinker = byProv("conversion_linker");

    const declared = Object.entries({
      "Google Ads": googleAds.length + floodlight.length,
      "Meta": meta.length,
      "TikTok": tiktok.length,
      "LinkedIn": linkedin.length,
      "Bing": bing.length
    }).filter(([, n]) => n > 0).map(([k]) => k);

    out.push({
      id: "ADS-001", severity: "info", status: declared.length ? "pass" : "info",
      title: "Ad platforms detected on page",
      evidence: { declared, counts: { googleAds: googleAds.length, floodlight: floodlight.length, meta: meta.length, tiktok: tiktok.length, linkedin: linkedin.length, bing: bing.length } }
    });

    // R114–R117 — Conversion Linker / _gcl_* cookies present when Google Ads conversions exist
    if (googleAds.length || floodlight.length) {
      const hasGcl = (cookies || []).some((c) => /^_gcl_/.test(c.name));
      out.push({
        id: "ADS-002", severity: "high",
        status: hasGcl || conversionLinker.length ? "pass" : "fail",
        title: "Conversion Linker present (GCLID preservation)",
        evidence: { gclCookies: (cookies || []).filter((c) => /^_gcl_/.test(c.name)).map((c) => c.name), conversionLinkerHits: conversionLinker.length }
      });

      // R113 — post-April-2025: googtag must fire first
      const googtagFirst = annotated.find((r) => r.provider?.key === "gtm_loader" && /id=G-|id=GT-|id=AW-/.test(r.url));
      out.push({
        id: "ADS-003", severity: "high",
        status: googtagFirst ? "pass" : "warn",
        title: "Google Tag (gtag) loader precedes Ads conversions",
        evidence: { loader: googtagFirst ? googtagFirst.url : null }
      });
    }

    // R128–R129 — conversion tags without value
    const adsNoValue = [...googleAds].filter((r) => !r.fields?.value);
    if (googleAds.length) {
      out.push({
        id: "ADS-004", severity: "medium",
        status: adsNoValue.length === googleAds.length ? "warn" : "pass",
        title: "Google Ads conversions carry value",
        evidence: { total: googleAds.length, missingValue: adsNoValue.length }
      });
    }

    // R132–R133 — Floodlight ordinal uniqueness
    if (floodlight.length) {
      const ords = floodlight.map((r) => r.fields?.ord).filter(Boolean);
      const unique = new Set(ords).size;
      out.push({
        id: "ADS-005", severity: "medium",
        status: ords.length && unique === ords.length ? "pass" : "warn",
        title: "Floodlight sales tags carry unique ord=",
        evidence: { total: floodlight.length, ords, uniqueOrds: unique }
      });
    }

    // R138–R143 — click-ID capture
    const clickIds = pageState?.clickIds || {};
    out.push({
      id: "ADS-006", severity: "info",
      status: Object.keys(clickIds).length ? "pass" : "info",
      title: "Platform click IDs present in landing URL",
      evidence: { clickIds }
    });

    // R144–R147 — UTM persistence in localStorage
    const utm = pageState?.utmStorage || {};
    out.push({
      id: "ADS-007", severity: "low",
      status: Object.keys(utm).length ? "pass" : "info",
      title: "UTM values persisted to localStorage (iOS ITP resilience)",
      evidence: { keys: Object.keys(utm), sample: utm }
    });

    // R134–R137 — conversion-named tags firing on many pages (heuristic)
    if (googleAds.length > 3) {
      const pages = new Set(googleAds.map((r) => { try { return new URL(r.url).pathname; } catch { return r.url; } }));
      out.push({
        id: "ADS-008", severity: "high",
        status: pages.size > 2 ? "warn" : "pass",
        title: "Google Ads conversion fires on ≤ 2 distinct pages",
        evidence: { conversions: googleAds.length, distinctPaths: pages.size }
      });
    }

    return out;
  }

  const api = { run };
  if (typeof module !== "undefined") module.exports = api;
  root.TTRules = root.TTRules || {};
  root.TTRules.ads = api;
})(typeof window !== "undefined" ? window : self);

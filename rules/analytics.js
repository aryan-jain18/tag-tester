// GA4 config rules — maps to R87–R96.

(function (root) {
  function run(ctx) {
    const out = [];
    const { annotated, pageState } = ctx;
    const loaders = annotated.filter((r) => r.provider?.key === "gtm_loader");
    const ga4 = annotated.filter((r) => r.provider?.key === "ga4");

    // R87–R88 — GA4 config / events exist but no loader
    out.push({
      id: "ANALYTICS-001", severity: "critical",
      status: loaders.length ? "pass" : (ga4.length ? "fail" : "info"),
      title: "GA4 / gtag loader present on page",
      evidence: { loaders: loaders.map((r) => ({ url: r.url, id: r.fields?.id })) }
    });

    // R89–R90 — multiple active measurement IDs
    const ids = Array.from(new Set(ga4.map((r) => r.fields?.tid).filter(Boolean)));
    out.push({
      id: "ANALYTICS-002", severity: ids.length > 1 ? "medium" : "info",
      status: ga4.length === 0 ? "skip" : (ids.length <= 1 ? "pass" : "warn"),
      title: "Single active GA4 measurement ID",
      evidence: { measurementIds: ids, hits: ga4.length }
    });

    // R91–R92 — multiple loader calls for same id (duplicate config)
    const loaderIds = loaders.map((r) => r.fields?.id).filter(Boolean);
    const dupIds = loaderIds.filter((id, i) => loaderIds.indexOf(id) !== i);
    out.push({
      id: "ANALYTICS-003", severity: "low",
      status: dupIds.length ? "warn" : "pass",
      title: "No duplicate loader calls for same container ID",
      evidence: { loaderIds, duplicates: Array.from(new Set(dupIds)) }
    });

    // R95–R96 — debug_mode=1 in production
    const debugHits = ga4.filter((r) => /\b_dbg=1\b|\bdebug_mode=true\b|\bdebug_mode=1\b/.test(r.url + "&" + (r.postBody || "")));
    out.push({
      id: "ANALYTICS-004", severity: "high",
      status: ga4.length === 0 ? "skip" : (debugHits.length ? "warn" : "pass"),
      title: "GA4 debug_mode not enabled in production",
      evidence: { debugHits: debugHits.length, sample: debugHits[0]?.url || null }
    });

    // R107–R108 — GA4 events missing measurement_id
    const missingTid = ga4.filter((r) => !r.fields?.tid);
    out.push({
      id: "ANALYTICS-005", severity: "critical",
      status: ga4.length === 0 ? "skip" : (missingTid.length ? "fail" : "pass"),
      title: "Every GA4 hit carries a measurement ID (tid)",
      evidence: { total: ga4.length, missing: missingTid.length }
    });

    // Container inventory from page (google_tag_manager object)
    out.push({
      id: "ANALYTICS-006", severity: "info", status: "info",
      title: "GTM / Google Tag containers detected on page",
      evidence: { containers: pageState?.gtm?.containers || [] }
    });

    return out;
  }

  const api = { run };
  if (typeof module !== "undefined") module.exports = api;
  root.TTRules = root.TTRules || {};
  root.TTRules.analytics = api;
})(typeof window !== "undefined" ? window : self);

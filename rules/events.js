// GA4 event-schema rules — maps to R98–R110.

(function (root) {
  function run(ctx) {
    const out = [];
    const { annotated, pageState } = ctx;
    const ga4 = annotated.filter((r) => r.provider?.key === "ga4");

    // Flatten all events across all GA4 requests
    const events = [];
    for (const r of ga4) {
      for (const e of r.fields?.events || []) events.push({ ...e, _url: r.url, _body: r.postBody });
    }
    const purchases = events.filter((e) => e.en === "purchase");
    const pageViews = events.filter((e) => e.en === "page_view");

    // R98–R99 — purchase missing value/currency/items
    const purchaseIssues = purchases.map((e) => {
      const issues = [];
      if (!e["epn.value"] && !e.value && !e.tr) issues.push("value");
      if (!e["ep.currency"] && !e.currency && !e.cu) issues.push("currency");
      if (!(e.items_raw && e.items_raw.length)) issues.push("items[]");
      return { issues, sample: { ...e, _url: undefined, _body: undefined } };
    }).filter((x) => x.issues.length);
    out.push({
      id: "EVENTS-001", severity: "critical",
      status: purchases.length === 0 ? "skip" : (purchaseIssues.length ? "fail" : "pass"),
      title: "GA4 purchase events include value, currency, items[]",
      evidence: { purchaseCount: purchases.length, withIssues: purchaseIssues.slice(0, 10) }
    });

    // R100–R102 — value without currency (GA4 drops revenue)
    const valNoCur = events.filter((e) => (e["epn.value"] || e.value) && !(e["ep.currency"] || e.currency || e.cu));
    out.push({
      id: "EVENTS-002", severity: "critical",
      status: events.length === 0 ? "skip" : (valNoCur.length ? "fail" : "pass"),
      title: "No GA4 event has value without currency",
      evidence: { offenders: valNoCur.slice(0, 10).map((e) => e.en) }
    });

    // R103–R105 — value must be numeric
    const valMalformed = events.filter((e) => {
      const v = e["epn.value"] ?? e.value;
      if (v === undefined || v === "") return false;
      return Number.isNaN(Number(v));
    });
    out.push({
      id: "EVENTS-003", severity: "high",
      status: events.length === 0 ? "skip" : (valMalformed.length ? "fail" : "pass"),
      title: "Event value parameter is numeric",
      evidence: { offenders: valMalformed.slice(0, 10).map((e) => ({ en: e.en, value: e["epn.value"] ?? e.value })) }
    });

    // R106 — manual page_view + auto page_view double-count
    const autoPv = pageState?.gtm?.containers?.length && pageViews.length;
    const manualPvInDL = (pageState?.dataLayer || []).some((p) => {
      const e = p.e || {};
      return e.event === "page_view" || (Array.isArray(e) && e[0] === "event" && e[1] === "page_view");
    });
    out.push({
      id: "EVENTS-004", severity: "medium",
      status: pageViews.length <= 1 ? "pass" : "warn",
      title: "page_view fires once per navigation",
      evidence: { pageViewHits: pageViews.length, manualInDataLayer: manualPvInDL, autoDetected: !!autoPv }
    });

    // R130–R131 — multiple revenue events active (purchase + custom revenue)
    const revenueEvents = events.filter((e) => (e["epn.value"] || e.value) && e.en !== "purchase");
    if (purchases.length && revenueEvents.length) {
      out.push({
        id: "EVENTS-005", severity: "high", status: "warn",
        title: "Only one revenue event active",
        evidence: { purchases: purchases.length, otherRevenueEvents: revenueEvents.map((e) => e.en) }
      });
    } else {
      out.push({
        id: "EVENTS-005", severity: "info",
        status: events.length === 0 ? "skip" : "pass",
        title: "Only one revenue event active",
        evidence: { purchases: purchases.length, otherRevenueEvents: [] }
      });
    }

    // R109–R110 — ecommerce dataLayer schema (UA vs GA4)
    const dlEcom = (pageState?.dataLayer || []).map((p) => p.e).filter((e) => e && (e.ecommerce || e.event?.match(/^add_to_cart|purchase|view_item/)));
    const uaShape = dlEcom.some((e) => e?.ecommerce?.purchase?.products || e?.ecommerce?.add?.products);
    const ga4Shape = dlEcom.some((e) => Array.isArray(e?.ecommerce?.items));
    out.push({
      id: "EVENTS-006", severity: uaShape && !ga4Shape ? "high" : "info",
      status: dlEcom.length === 0 ? "skip" : (uaShape && !ga4Shape ? "fail" : "pass"),
      title: "Ecommerce dataLayer uses GA4 items[] schema (not UA products[])",
      evidence: { uaShape, ga4Shape, samplePushes: dlEcom.slice(0, 3) }
    });

    return out;
  }

  const api = { run };
  if (typeof module !== "undefined") module.exports = api;
  root.TTRules = root.TTRules || {};
  root.TTRules.events = api;
})(typeof window !== "undefined" ? window : self);

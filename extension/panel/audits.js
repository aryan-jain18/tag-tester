// Audit engine. Takes the collected context and returns per-audit results.
// status: "pass" | "warn" | "fail" | "info" | "skip"

const AUDIT_DEFS = [
  {
    id: "AUD-001", name: "Library Load & Performance Time", category: "Performance",
    run: (ctx) => {
      const thirdParty = ctx.requests.filter(r => ["script","stylesheet"].includes(r.type) && isThirdParty(r.url, ctx.host));
      const rt = ctx.resourceTiming || [];
      const rows = thirdParty.slice(0, 300).map(r => {
        const rtEntry = rt.find(e => e.name === r.url);
        return {
          url: r.url,
          type: r.type,
          status: r.status,
          dns: rtEntry?.dns ?? "",
          tcp: rtEntry?.tcp ?? "",
          ttfb: rtEntry?.ttfb ?? "",
          duration: rtEntry?.duration ?? ""
        };
      });
      const slow = rows.filter(r => +r.duration > 1000);
      return {
        status: slow.length ? "warn" : (rows.length ? "pass" : "info"),
        summary: `${rows.length} third-party libraries loaded. ${slow.length} slow (>1s).`,
        table: { columns: ["url","type","status","dns","tcp","ttfb","duration"], rows }
      };
    }
  },
  {
    id: "AUD-002", name: "Console Errors Logging", category: "Debugging",
    run: (ctx) => {
      const errs = (ctx.console || []).filter(c => c.level === "error");
      return {
        status: errs.length ? "fail" : "pass",
        summary: `${errs.length} console error(s).`,
        table: { columns: ["level","message","source"], rows: errs.map(e => ({ level: e.level, message: e.message, source: e.source || "" })) }
      };
    }
  },
  {
    id: "AUD-003", name: "Cookie Auditing", category: "Privacy",
    run: (ctx) => {
      const rows = (ctx.cookies || []).map(c => {
        const isThird = !sameRegDomain(c.domain, ctx.host);
        const tag = isConsentCookie(c.name) ? "consent" : isFunctionalCookie(c.name) ? "functional" : isThird ? "third-party-tracking" : "first-party";
        return { name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expirationDate: c.expirationDate ? new Date(c.expirationDate*1000).toISOString() : "session", category: tag };
      });
      const third = rows.filter(r => r.category === "third-party-tracking").length;
      return {
        status: third ? "warn" : (rows.length ? "pass" : "info"),
        summary: `${rows.length} cookies — ${third} third-party tracking.`,
        table: { columns: ["name","domain","path","secure","httpOnly","sameSite","category","expirationDate"], rows }
      };
    }
  },
  {
    id: "AUD-004", name: "CDP/Integration Data Flow", category: "Compliance",
    run: (ctx) => {
      const cdpKeys = ["hubspot","segment","klaviyo"];
      const hits = ctx.requests.filter(r => r.provider && cdpKeys.includes(r.provider.key));
      const msg = ctx.consentDenied
        ? (hits.length ? "FAIL: CDP/CRM traffic sent while consent is denied." : "No CDP/CRM traffic during denied-consent session.")
        : "Consent-denied mode is OFF — tick the 'Simulate consent denied' box, reload, and re-run to verify.";
      return {
        status: ctx.consentDenied ? (hits.length ? "fail" : "pass") : "info",
        summary: msg,
        table: { columns: ["url","provider","category","status"], rows: hits.map(h => ({ url: h.url, provider: h.provider.name, category: h.provider.category, status: h.status })) }
      };
    }
  },
  {
    id: "AUD-005", name: "Ad Tracking Flow Verification", category: "Privacy",
    run: (ctx) => {
      const adKeys = ["fb","tiktok","linkedin","reddit","bing","pinterest","snap","twitter","dv360"];
      const hits = ctx.requests.filter(r => r.provider && adKeys.includes(r.provider.key));
      const msg = ctx.consentDenied
        ? (hits.length ? "FAIL: ad/tracking pixels fired while consent is denied." : "No ad/tracking pixel fired while consent denied.")
        : `${hits.length} ad/tracking pixel calls captured (consent-denied mode OFF — can't verify blocking).`;
      return {
        status: ctx.consentDenied ? (hits.length ? "fail" : "pass") : "info",
        summary: msg,
        table: { columns: ["url","provider","status"], rows: hits.map(h => ({ url: h.url, provider: h.provider.name, status: h.status })) }
      };
    }
  },
  {
    id: "AUD-006", name: "Zero-Cookie Load Test", category: "Privacy",
    run: (ctx) => {
      // Flag any non-essential cookies present before any interaction.
      const bad = (ctx.cookies || []).filter(c => !isConsentCookie(c.name) && !isFunctionalCookie(c.name));
      const instruction = "Clear cookies for this site, reload, and re-run without clicking the banner. Any cookie listed here was set before user consent.";
      return {
        status: bad.length ? "fail" : "pass",
        summary: `${bad.length} potentially non-essential cookies found pre-interaction. ${instruction}`,
        table: { columns: ["name","domain","secure"], rows: bad.map(c => ({ name: c.name, domain: c.domain, secure: c.secure })) }
      };
    }
  },
  {
    id: "AUD-007", name: "Local/Session Storage Sneaking", category: "Privacy",
    run: (ctx) => {
      const s = ctx.storage || { local: {}, session: {}, idbDbs: [] };
      const suspicious = /^(fbp|_ga|_gid|_uid|uid|vid|sid|session|user_id|visitor|tiktok|snap|lintrk|_pin|_hj|mp_)/i;
      const local = Object.entries(s.local || {});
      const session = Object.entries(s.session || {});
      const idb = s.idbDbs || [];
      const trackerish = [...local, ...session].filter(([k,v]) => suspicious.test(k) || (typeof v === "string" && /[0-9a-f]{16,}/i.test(v)));
      return {
        status: trackerish.length || idb.length ? "warn" : "pass",
        summary: `local=${local.length} session=${session.length} idb=${idb.length}. Possible tracker-like keys: ${trackerish.length}.`,
        table: { columns: ["store","key","preview"], rows:
          local.slice(0,100).map(([k,v]) => ({ store:"local", key:k, preview: String(v).slice(0,200) }))
          .concat(session.slice(0,100).map(([k,v]) => ({ store:"session", key:k, preview: String(v).slice(0,200) })))
          .concat(idb.map(n => ({ store: "indexedDB", key: n, preview: "" })))
        }
      };
    }
  },
  {
    id: "AUD-008", name: "Third-Party Domain Requests", category: "Privacy",
    run: (ctx) => {
      const domains = new Map();
      for (const r of ctx.requests) {
        try {
          const h = new URL(r.url).hostname;
          if (!sameRegDomain(h, ctx.host)) {
            const d = regDomain(h);
            domains.set(d, (domains.get(d) || 0) + 1);
          }
        } catch {}
      }
      const rows = Array.from(domains.entries()).sort((a,b)=>b[1]-a[1]).map(([domain,count]) => ({ domain, count }));
      return {
        status: rows.length > 30 ? "warn" : rows.length ? "info" : "pass",
        summary: `${rows.length} third-party domains contacted.`,
        table: { columns: ["domain","count"], rows }
      };
    }
  },
  {
    id: "AUD-009", name: "Core Web Vitals", category: "Performance",
    run: (ctx) => {
      const v = ctx.cwv || {};
      const status = (() => {
        if (v.LCP == null) return "info";
        if (v.LCP > 4000 || (v.CLS||0) > 0.25 || (v.INP||0) > 500) return "fail";
        if (v.LCP > 2500 || (v.CLS||0) > 0.1 || (v.INP||0) > 200) return "warn";
        return "pass";
      })();
      return {
        status,
        summary: `LCP=${fmt(v.LCP,"ms")} CLS=${(v.CLS||0).toFixed(3)} INP=${fmt(v.INP,"ms")} FCP=${fmt(v.FCP,"ms")} TTFB=${fmt(v.TTFB,"ms")}`,
        table: { columns: ["metric","value"], rows: [
          { metric: "LCP (ms)", value: v.LCP ?? "" },
          { metric: "CLS", value: v.CLS ?? "" },
          { metric: "INP (ms)", value: v.INP ?? "" },
          { metric: "FCP (ms)", value: v.FCP ?? "" },
          { metric: "TTFB (ms)", value: v.TTFB ?? "" }
        ]}
      };
    }
  },
  {
    id: "AUD-010", name: "Asset Size Warnings", category: "Performance",
    run: (ctx) => {
      const issues = [];
      for (const r of ctx.requests) {
        const headers = headersToMap(r.responseHeaders);
        const ce = (headers["content-encoding"] || "").toLowerCase();
        const ct = (headers["content-type"] || "").toLowerCase();
        const cl = parseInt(headers["content-length"] || "0", 10);
        const isText = /javascript|css|json|html|svg|xml/.test(ct);
        if (isText && cl > 10000 && !ce) issues.push({ url: r.url, reason: "Uncompressed text asset (no gzip/br)", size: cl, contentType: ct });
        if (ct.startsWith("image/") && cl > 1024*1024) issues.push({ url: r.url, reason: "Oversized image (>1MB)", size: cl, contentType: ct });
      }
      return {
        status: issues.length ? "warn" : "pass",
        summary: `${issues.length} asset size issue(s).`,
        table: { columns: ["url","reason","size","contentType"], rows: issues.slice(0,300) }
      };
    }
  },
  {
    id: "AUD-011", name: "Render-Blocking Resources", category: "Performance",
    run: (ctx) => {
      const dom = ctx.dom || {};
      const blockScripts = (dom.scripts||[]).filter(s => s.src && s.inHead && !s.async && !s.defer);
      const blockCss = (dom.stylesheets||[]).filter(l => l.inHead && (!l.media || /all|screen|^$/.test(l.media)) && !l.disabled);
      return {
        status: (blockScripts.length + blockCss.length) ? "warn" : "pass",
        summary: `${blockScripts.length} blocking <head> scripts, ${blockCss.length} blocking stylesheets.`,
        table: { columns: ["kind","url","async","defer","media"], rows:
          blockScripts.map(s => ({ kind:"script", url: s.src, async: s.async, defer: s.defer, media: "" }))
            .concat(blockCss.map(l => ({ kind: "stylesheet", url: l.href, async: "", defer: "", media: l.media })))
        }
      };
    }
  },
  {
    id: "AUD-012", name: "Mixed Content Warnings", category: "Security",
    run: (ctx) => {
      if (!ctx.origin?.startsWith("https://")) return { status: "skip", summary: "Page not served over HTTPS.", table: null };
      const mixed = ctx.requests.filter(r => r.url.startsWith("http://") && !r.url.startsWith("http://localhost"));
      return {
        status: mixed.length ? "fail" : "pass",
        summary: `${mixed.length} insecure HTTP request(s) from HTTPS page.`,
        table: { columns: ["url","type","status"], rows: mixed.map(r => ({ url: r.url, type: r.type, status: r.status })) }
      };
    }
  },
  {
    id: "AUD-013", name: "Missing Essential Meta Tags", category: "SEO",
    run: (ctx) => {
      const m = ctx.dom?.metas || {};
      const missing = [];
      if (!m.viewport) missing.push("viewport");
      if (!m.canonical) missing.push("canonical");
      if (!m.description) missing.push("description");
      if (!m.ogTitle) missing.push("og:title");
      if (!m.ogImage) missing.push("og:image");
      if (!m.ogDescription) missing.push("og:description");
      if (!m.twitterCard) missing.push("twitter:card");
      if (!m.title) missing.push("<title>");
      return {
        status: missing.length ? "warn" : "pass",
        summary: missing.length ? `Missing: ${missing.join(", ")}` : "All essential meta tags present.",
        table: { columns: ["tag","value"], rows: Object.entries(m).map(([k,v]) => ({ tag: k, value: v || "" })) }
      };
    }
  },
  {
    id: "AUD-014", name: "PII Leakage Detection", category: "Privacy",
    run: (ctx) => {
      const pats = {
        email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        phone: /\+?\d[\d \-().]{8,15}\d/g,
        ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
        md5: /\b[a-f0-9]{32}\b/gi,
        sha256: /\b[a-f0-9]{64}\b/gi
      };
      const hits = [];
      const cookieBlob = (ctx.cookies||[]).map(c => `${c.name}=${c.value||""}`).join("\n");
      checkBlob("cookie-jar", cookieBlob);
      for (const r of ctx.requests) {
        checkBlob("url:"+truncate(r.url,80), r.url);
        if (r.postBody) checkBlob("body:"+truncate(r.url,80), r.postBody);
      }
      function checkBlob(source, blob) {
        for (const [name, re] of Object.entries(pats)) {
          const m = blob.match(re);
          if (m) hits.push({ source, kind: name, sample: m.slice(0,3).join(", ") });
        }
      }
      return {
        status: hits.length ? "fail" : "pass",
        summary: `${hits.length} potential PII occurrence(s).`,
        table: { columns: ["source","kind","sample"], rows: hits.slice(0,300) }
      };
    }
  },
  {
    id: "AUD-015", name: "Third-Party iFrame Audits", category: "Privacy",
    run: (ctx) => {
      const iframes = (ctx.dom?.iframes || []).filter(f => f.src && !sameRegDomain(new URL(f.src, ctx.origin).hostname, ctx.host));
      return {
        status: iframes.length ? "warn" : "pass",
        summary: `${iframes.length} third-party iframe(s). Each may set its own cookies/storage.`,
        table: { columns: ["src","sandbox","name"], rows: iframes.map(f => ({ src: f.src, sandbox: f.sandbox || "", name: f.name || "" })) }
      };
    }
  },
  {
    id: "AUD-016", name: "Tag Schema Validation", category: "Debugging",
    run: (ctx) => {
      const issues = [];
      for (const r of ctx.requests) {
        if (!r.provider) continue;
        const f = r.provider.fields || {};
        if (r.provider.key === "ga4" && !f["Measurement ID"]) issues.push({ provider: "GA4", url: r.url, issue: "Missing tid (Measurement ID)" });
        if (r.provider.key === "ga4" && !f["Event Name"]) issues.push({ provider: "GA4", url: r.url, issue: "Missing en (Event Name)" });
        if (r.provider.key === "fb" && !f["Pixel ID"]) issues.push({ provider: "Meta Pixel", url: r.url, issue: "Missing id (Pixel ID)" });
        if (r.provider.key === "fb" && !f["Event"]) issues.push({ provider: "Meta Pixel", url: r.url, issue: "Missing ev (Event)" });
        if (r.provider.key === "bing" && !f["Tag ID"]) issues.push({ provider: "Bing UET", url: r.url, issue: "Missing ti (Tag ID)" });
        if (r.provider.key === "tiktok" && !f["Pixel Code"]) issues.push({ provider: "TikTok", url: r.url, issue: "Missing pixel code" });
        if (r.provider.key === "linkedin" && !f["Partner ID"]) issues.push({ provider: "LinkedIn", url: r.url, issue: "Missing pid (Partner ID)" });
      }
      return {
        status: issues.length ? "warn" : "pass",
        summary: `${issues.length} schema issue(s) across tag payloads.`,
        table: { columns: ["provider","issue","url"], rows: issues.slice(0,300) }
      };
    }
  },
  {
    id: "AUD-017", name: "Event Duplication", category: "Debugging",
    run: (ctx) => {
      // Group provider+event-name+pageloc; flag identical events firing within 1s.
      const buckets = new Map();
      for (const r of ctx.requests) {
        if (!r.provider) continue;
        const f = r.provider.fields || {};
        const key = r.provider.key + "|" + (f["Event Name"] || f["Event"] || f["Event Action"] || "") + "|" + (f["Page Location"] || "");
        const arr = buckets.get(key) || [];
        arr.push(r);
        buckets.set(key, arr);
      }
      const dupes = [];
      for (const [k, arr] of buckets) {
        if (arr.length < 2) continue;
        arr.sort((a,b)=>a.timeStamp-b.timeStamp);
        for (let i=1;i<arr.length;i++) {
          if (arr[i].timeStamp - arr[i-1].timeStamp < 1000) { dupes.push({ key: k, count: arr.length, deltaMs: Math.round(arr[i].timeStamp - arr[i-1].timeStamp) }); break; }
        }
      }
      return {
        status: dupes.length ? "warn" : "pass",
        summary: `${dupes.length} duplicate-event cluster(s) detected.`,
        table: { columns: ["key","count","deltaMs"], rows: dupes }
      };
    }
  },
  {
    id: "AUD-018", name: "Unused or Dead Scripts", category: "Performance",
    run: (ctx) => {
      const errs = ctx.requests.filter(r => r.status && r.status >= 400).map(r => ({ url: r.url, status: r.status, type: r.type }));
      return {
        status: errs.length ? "fail" : "pass",
        summary: `${errs.length} resources returned 4xx/5xx.`,
        table: { columns: ["url","status","type"], rows: errs.slice(0,300) }
      };
    }
  },
  {
    id: "AUD-019", name: "Synchronous Script Blocking", category: "Performance",
    run: (ctx) => {
      const scripts = (ctx.dom?.scripts || []).filter(s => s.src && !s.async && !s.defer);
      const third = scripts.filter(s => { try { return !sameRegDomain(new URL(s.src).hostname, ctx.host); } catch { return false; } });
      return {
        status: third.length ? "warn" : "pass",
        summary: `${third.length} third-party synchronous scripts.`,
        table: { columns: ["src","inHead"], rows: third.map(s => ({ src: s.src, inHead: s.inHead })) }
      };
    }
  },
  {
    id: "AUD-020", name: "Exposed API Keys", category: "Security",
    run: (ctx) => {
      const domHits = (ctx.dom?.keyHits || []).flatMap(k => k.samples.map(s => ({ source: "DOM/inline", kind: k.name, sample: s })));
      // Also scan request URLs
      const rePats = [
        { name: "Stripe key", re: /(pk|sk)_(live|test)_[A-Za-z0-9]{16,}/g },
        { name: "Google API key", re: /AIza[0-9A-Za-z\-_]{35}/g },
        { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g }
      ];
      const reqHits = [];
      for (const r of ctx.requests) {
        for (const p of rePats) {
          const m = r.url.match(p.re);
          if (m) reqHits.push({ source: "network URL", kind: p.name, sample: m[0] });
        }
      }
      const all = domHits.concat(reqHits);
      return {
        status: all.length ? "fail" : "pass",
        summary: `${all.length} exposed key/token candidate(s).`,
        table: { columns: ["source","kind","sample"], rows: all.slice(0,200) }
      };
    }
  },
  {
    id: "AUD-021", name: "Console Warnings Logging", category: "Debugging",
    run: (ctx) => {
      const warns = (ctx.console || []).filter(c => c.level === "warn");
      return {
        status: warns.length > 20 ? "warn" : warns.length ? "info" : "pass",
        summary: `${warns.length} console warning(s).`,
        table: { columns: ["level","message"], rows: warns.map(w => ({ level: w.level, message: w.message })) }
      };
    }
  }
];

// Helpers
function regDomain(h) { if (!h) return ""; const p = h.split("."); return p.slice(-2).join("."); }
function sameRegDomain(a, b) { return regDomain(String(a).replace(/^\./,"")) === regDomain(String(b)); }
function isThirdParty(url, host) { try { return !sameRegDomain(new URL(url).hostname, host); } catch { return false; } }
function isConsentCookie(name) {
  const list = (self.CONSENT_COOKIE_HINTS) || ["OptanonConsent","CookieConsent","euconsent-v2","didomi_token","OneTrust"];
  return list.some(x => name && name.toLowerCase().includes(x.toLowerCase()));
}
function isFunctionalCookie(name) {
  const list = (self.FUNCTIONAL_COOKIE_HINTS) || ["session","csrf","auth","token","sid","lang","locale","cart"];
  return list.some(x => name && name.toLowerCase().includes(x.toLowerCase()));
}
function headersToMap(h) { const o = {}; (h||[]).forEach(x => o[x.name.toLowerCase()] = x.value); return o; }
function truncate(s, n) { return (s||"").length > n ? s.slice(0,n)+"…" : (s||""); }
function fmt(v, u) { return (v == null || Number.isNaN(v)) ? "—" : `${v}${u||""}`; }

window.AUDIT_DEFS = AUDIT_DEFS;
